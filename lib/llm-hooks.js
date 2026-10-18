import { outcomeOf } from "./limiter.js";
export class UsageMeter {
    byRoute = new Map();
    finishListeners = new Set();
    record(provider, model, usage) {
        const key = `${provider}/${model ?? '?'}`;
        const t = this.byRoute.get(key) ?? { requests: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
        const n = (...names) => {
            for (const name of names) {
                const v = usage?.[name];
                if (typeof v === 'number')
                    return v;
            }
            return 0;
        };
        t.inputTokens += n('input', 'inputTokens', 'promptTokens', 'prompt_tokens');
        t.outputTokens += n('output', 'outputTokens', 'completionTokens', 'completion_tokens');
        t.cacheHitTokens += n('cacheRead', 'cacheReadTokens', 'promptCacheHitTokens', 'prompt_cache_hit_tokens');
        t.cacheMissTokens += n('cacheMiss', 'promptCacheMissTokens', 'prompt_cache_miss_tokens');
        this.byRoute.set(key, t);
    }
    countRequest(provider, model) {
        const key = `${provider}/${model ?? '?'}`;
        const t = this.byRoute.get(key) ?? { requests: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
        t.requests++;
        this.byRoute.set(key, t);
    }
    /** Notify the stagger leader logic that some model response completed. */
    onFinish(listener) {
        this.finishListeners.add(listener);
        return () => this.finishListeners.delete(listener);
    }
    finished(provider) {
        for (const listener of [...this.finishListeners])
            listener(provider);
    }
    snapshot() {
        const out = {};
        for (const [key, t] of this.byRoute) {
            const cached = t.cacheHitTokens + t.cacheMissTokens;
            out[key] = { ...t, cacheHitRate: cached > 0 ? t.cacheHitTokens / cached : null };
        }
        return out;
    }
}
/**
 * Routes (provider + model) that fail deterministically — the provider is up,
 * but this model cannot serve requests through it: a gateway whose API dialect
 * does not match the model (e.g. an `anthropic-messages` gateway serving a
 * Gemini model → 400 "Unknown name anthropic_version"), an unknown model (404), a key without
 * access (401/403). Retrying the same route never helps, so it is benched for a
 * while and dispatched sessions move down their chain.
 */
export class RouteHealth {
    broken = new Map();
    probes = new Map();
    ttlMs;
    now;
    constructor(ttlMs = 30 * 60_000, now = () => Date.now()) {
        this.ttlMs = ttlMs;
        this.now = now;
    }
    static key(route) {
        return `${route.provider}/${route.model}`;
    }
    markBroken(route, reason) {
        this.broken.set(RouteHealth.key(route), { reason: reason.slice(0, 300), until: this.now() + this.ttlMs, at: new Date(this.now()).toISOString() });
    }
    clear(route) {
        this.broken.delete(RouteHealth.key(route));
    }
    isBroken(route) {
        const b = this.broken.get(RouteHealth.key(route));
        if (b === undefined)
            return false;
        if (b.until <= this.now()) {
            this.broken.delete(RouteHealth.key(route));
            return false;
        }
        return true;
    }
    recordProbe(route, ok, detail, latencyMs) {
        this.probes.set(RouteHealth.key(route), { ok, detail: detail.slice(0, 300), latencyMs, at: new Date(this.now()).toISOString() });
        if (ok)
            this.clear(route);
    }
    snapshot() {
        const broken = {};
        for (const [k, v] of this.broken)
            if (v.until > this.now())
                broken[k] = { reason: v.reason, until: new Date(v.until).toISOString() };
        return { broken, probes: Object.fromEntries(this.probes) };
    }
}
/** A failure that will repeat on every retry of the same route (not rate limits, not the prompt's own size). */
export function isDeterministicRouteFailure(failure) {
    const f = (failure ?? {});
    const message = typeof f.message === 'string' ? f.message : '';
    if (/context|too long|too many tokens|maximum.{0,20}tokens|prompt is too|length/i.test(message))
        return false;
    const status = typeof f.status === 'number' ? f.status : undefined;
    const code = typeof f.code === 'string' ? f.code.toUpperCase() : '';
    if (status !== undefined && [400, 401, 403, 404, 405, 415, 422].includes(status))
        return true;
    // Gateways report a retired or unrouted model as a 5xx ("not available"); that is the
    // route's fault, not provider overload (e.g. 500 "not available" for a retired model).
    if (/\bnot available\b|unsupported|does not exist|no such model|model not found|unknown model|no available channel/i.test(message))
        return true;
    return /NOT_FOUND|UNSUPPORTED|INVALID_MODEL|NO_ADAPTER|MISSING_CREDENTIAL|UNAUTHORI|FORBIDDEN|PERMISSION/.test(code);
}
export function installLlmHooks(ctx, deps) {
    const { limiter, usage, registry, events, health } = deps;
    /** The route each dispatched session's latest request actually used (agent/request-error carries no model). */
    const lastRoute = new Map();
    const healthy = (e) => !limiter.isOpen(e.provider) && !health.isBroken(e);
    /** A dead route must not count as provider overload, or one retired model would trip the breaker for the whole gateway. */
    const classify = (failure) => {
        const inner = failure?.failure ?? failure;
        return isDeterministicRouteFailure(inner) ? { outcome: 'error' } : outcomeOf(failure);
    };
    ctx.on('llm/stream', function (options, next) {
        return admitted(options, next);
    });
    async function* admitted(options, next) {
        const provider = options.provider ?? 'unknown';
        const lease = await limiter.acquire(provider, options.signal !== undefined ? { signal: options.signal } : {});
        usage.countRequest(provider, options.model);
        let outcome = 'cancelled';
        let retryAfterMs;
        try {
            for await (const chunk of next()) {
                if (chunk.type === 'usage')
                    usage.record(provider, options.model, chunk.usage);
                if (chunk.type === 'finish') {
                    if (chunk.reason?.kind === 'error')
                        ({ outcome, retryAfterMs } = classify(chunk.reason.failure));
                    else
                        outcome = 'ok';
                }
                yield chunk;
            }
        }
        catch (err) {
            ({ outcome, retryAfterMs } = classify(err));
            throw err;
        }
        finally {
            lease.release(outcome, retryAfterMs);
            if (outcome === 'ok')
                usage.finished(provider);
        }
    }
    const same = (e, c) => e.provider === c.provider && e.model === c.model;
    ctx.on('agent/request', async (payload, next) => {
        const current = await next();
        const root = registry.rootOf(payload.agent);
        if (root === undefined)
            return current;
        const sessionId = payload.agent.session.id;
        const chain = registry.get(root)?.chain ?? [];
        const keep = () => {
            lastRoute.set(sessionId, { provider: current.provider, model: current.model });
            return current;
        };
        if (chain.length === 0)
            return keep();
        const preferred = chain.find(healthy);
        if (preferred === undefined || same(preferred, current))
            return keep();
        // A route the user picked by hand outside the chain is respected while it is healthy.
        if (!chain.some(e => same(e, current)) && healthy({ provider: current.provider, model: current.model }))
            return keep();
        const reason = limiter.isOpen(current.provider) ? 'circuit-open'
            : health.isBroken({ provider: current.provider, model: current.model }) ? 'route-broken'
                : 'preferred-route-recovered';
        events.append('route/switch', {
            sessionId,
            root,
            from: `${current.provider}/${current.model}`,
            to: `${preferred.provider}/${preferred.model}`,
            reason,
        });
        lastRoute.set(sessionId, { provider: preferred.provider, model: preferred.model });
        const { reasoningEffort: _dropped, ...rest } = current;
        return {
            ...rest,
            provider: preferred.provider,
            model: preferred.model,
            ...preferred.effort !== undefined ? { reasoningEffort: preferred.effort } : {},
        };
    });
    // A deterministic route failure on a dispatched session benches the route and
    // retries the step; agent/request then picks the next healthy route of the chain.
    ctx.on('agent/request-error', async (payload, next) => {
        const root = registry.rootOf(payload.agent);
        if (root === undefined || !isDeterministicRouteFailure(payload.failure))
            return next();
        const used = lastRoute.get(payload.agent.session.id);
        if (used === undefined)
            return next();
        const message = String(payload.failure?.message ?? 'request failed');
        health.markBroken(used, message);
        events.append('route/broken', { sessionId: payload.agent.session.id, root, route: RouteHealth.key(used), reason: message.slice(0, 300) });
        const chain = registry.get(root)?.chain ?? [];
        if (!chain.some(healthy))
            return next(); // nothing left to fall back to: let the failure surface
        return { kind: 'retry' };
    }, { prepend: true });
}
/** Probe routes with one tiny real request each; records health and benches deterministic failures. */
export async function probeRoutes(ctx, health, routes, timeoutMs = 60_000) {
    return Promise.all(routes.map(async (route) => {
        const started = Date.now();
        const signal = AbortSignal.timeout(timeoutMs);
        let ok = false;
        let detail = '';
        try {
            for await (const chunk of ctx.llm.stream({
                provider: route.provider,
                model: route.model,
                messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }] }],
                maxTokens: 64,
                signal,
            })) {
                if (chunk.type === 'finish') {
                    ok = chunk.reason?.kind !== 'error';
                    detail = ok ? `finish:${chunk.reason?.kind ?? '?'}` : String(chunk.reason?.failure?.message ?? 'error');
                    if (!ok && isDeterministicRouteFailure(chunk.reason?.failure))
                        health.markBroken(route, detail);
                }
            }
        }
        catch (err) {
            detail = err instanceof Error ? err.message : String(err);
            if (isDeterministicRouteFailure(err) || isDeterministicRouteFailure(err.failure))
                health.markBroken(route, detail);
        }
        const latencyMs = Date.now() - started;
        health.recordProbe(route, ok, detail, latencyMs);
        return { route: RouteHealth.key(route), ok, latencyMs, detail };
    }));
}
