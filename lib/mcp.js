/**
 * The MCP surface (Streamable HTTP on loopback). Tool names carry the `djy_`
 * prefix; the interface is vendor-neutral so a future multi-CLI hub can expose
 * the same tools for other engines.
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { checkRequest } from "./auth.js";
import { ORCHESTRATOR_GUIDE } from "./guide.js";
import { probeRoutes } from "./llm-hooks.js";
import { preflightWorkspace } from "./preflight.js";
import { clientLabel } from "./sessions.js";
export const VERSION = '0.1.0-alpha.1';
const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const fail = (message, extra = {}) => ({ ...json({ error: message, ...extra }), isError: true });
const route = z.object({ provider: z.string(), model: z.string(), effort: z.string().optional() });
function registerTools(mcp, d) {
    const decider = () => mcp.server.getClientVersion()?.name ?? 'mcp-client';
    // One MCP connection = one orchestrator run; its sessions form a batch unless the caller names one.
    const connectedAt = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const defaultBatch = () => `${clientLabel(decider())} · ${pad(connectedAt.getMonth() + 1)}-${pad(connectedAt.getDate())} ${pad(connectedAt.getHours())}:${pad(connectedAt.getMinutes())}`;
    mcp.registerTool('djy_guide', {
        description: 'Read this first: the orchestrator playbook — workflow, how to decide approvals, and known pitfalls (Windows sandbox labels, JSON path escaping, rate-limited gateway keys, benchmark isolation) with how to avoid each.',
    }, async () => json(ORCHESTRATOR_GUIDE));
    mcp.registerTool('djy_status', {
        description: 'Dujiangyan status: version, workspace roots, dispatched sessions, running tasks, pending approvals, leases, per-provider admission state (cap, in-flight, circuit) and token usage per route.',
    }, async () => json({
        version: VERSION,
        workspaceRoots: d.config.workspaceRoots,
        sessions: d.registry.list(),
        activeTasks: d.tasks.active,
        limits: { maxSessions: d.config.maxSessions || 'unlimited', maxActiveSessions: d.config.maxActiveSessions || 'unlimited' },
        tasks: d.tasks.list().filter(t => t.status === 'running' || t.status === 'queued' || t.status === 'waiting_resources' || t.status === 'waiting_slot'),
        pendingApprovals: d.approvals.list().length,
        leases: d.leases.list(),
        providers: d.limiter.snapshot(),
        usage: d.usage.snapshot(),
        routeHealth: d.health.snapshot(),
        roster: d.config.roster,
    }));
    mcp.registerTool('djy_models', {
        description: 'List the LLM providers and models this Harness host can route to (for building rosters and explicit routes).',
        inputSchema: { provider: z.string().optional().describe('Only this provider') },
    }, async ({ provider }) => {
        const providers = d.ctx.llm.listProviders().map(p => String(p.id ?? p.name ?? '')).filter(p => p !== '');
        const out = {};
        for (const p of provider !== undefined ? [provider] : providers) {
            try {
                out[p] = (await d.ctx.llm.listModels(p)).map(m => m.id);
            }
            catch (err) {
                out[p] = { error: err instanceof Error ? err.message : String(err) };
            }
        }
        return json(out);
    });
    mcp.registerTool('djy_routes_probe', {
        description: 'Check which routes really work: one tiny real request (a few tokens) per route. Probes are bare model calls — no sessions are created, so nothing appears in the desktop session list; results go to the event log (routes/probed) and the audit log. A model listed in a provider catalog can still be unusable (e.g. a gateway whose API dialect does not match the model). Failing routes are benched so sessions skip them. Give explicit routes, or a provider plus models.',
        inputSchema: {
            routes: z.array(z.object({ provider: z.string(), model: z.string() })).optional(),
            provider: z.string().optional(),
            models: z.array(z.string()).optional(),
        },
    }, async ({ routes, provider, models }) => {
        const list = routes ?? (provider !== undefined && models !== undefined ? models.map(model => ({ provider, model })) : []);
        if (list.length === 0)
            return fail('give routes, or provider + models');
        if (list.length > 40)
            return fail('probe at most 40 routes per call');
        const results = await probeRoutes(d.ctx, d.health, list);
        // Probes are bare model calls (no sessions are created), so record them where people can find them.
        const failed = results.filter(r => !r.ok);
        d.events.append('routes/probed', {
            count: results.length,
            ok: results.length - failed.length,
            failed: failed.map(r => ({ route: r.route, detail: r.detail.slice(0, 160) })),
            by: decider(),
        });
        d.audit({ type: 'routes/probed', by: decider(), results });
        return json(results);
    });
    mcp.registerTool('djy_limits_set', {
        description: 'Temporarily override one provider\'s admission limits (in memory; the profile config applies again after a restart). Use it to match a key\'s real limits or to test rate-limit handling. Returns the effective limits.',
        inputSchema: {
            provider: z.string(),
            maxConcurrent: z.number().int().min(1).max(200).optional(),
            rpm: z.number().int().min(0).optional(),
            minSpacingMs: z.number().int().min(0).optional(),
            jitterMs: z.number().int().min(0).optional(),
            increaseAfter: z.number().int().min(1).optional(),
            breakerThreshold: z.number().int().min(1).optional(),
            breakerCooldownMs: z.number().int().min(0).optional(),
        },
    }, async ({ provider, ...patch }) => {
        const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
        const effective = d.limiter.setLimit(provider, clean);
        d.events.append('limits/override', { provider, ...clean });
        return json({ provider, effective, snapshot: d.limiter.snapshot()[provider] });
    });
    mcp.registerTool('djy_preflight', {
        description: 'Check a workspace directory for environment problems sandboxed workers would hit (Windows: directories without the Low integrity label). Read-only; returns suggested repairs.',
        inputSchema: { cwd: z.string() },
    }, async ({ cwd }) => json({ issues: await preflightWorkspace(cwd, d.config.permissionPreset) }));
    mcp.registerTool('djy_session_create', {
        description: 'Create a worker session in the running DeepSeek Harness. Give a roster role (implementer/reviewer/planner/...) or an explicit route. The session runs with the workspace-write preset behind the Dujiangyan gate. Its desktop title is prefixed with the creating client ([claude], [codex]). There is no need to limit how many sessions exist: API pressure is controlled per request by the admission layer.',
        inputSchema: {
            cwd: z.string().describe('Working directory; must be inside a configured workspace root'),
            role: z.string().optional(),
            route: route.optional(),
            fallbacks: z.array(route).optional().describe('With route: fallback routes in order (the session chain). Requests use the first healthy route; a tripped breaker or a benched route moves them down the chain.'),
            title: z.string().optional(),
            batch: z.string().max(60).optional().describe('Batch label to group this dispatch run (e.g. "nightly"); defaults to this connection, e.g. "codex · MM-DD HH:mm". The desktop panel archives by batch.'),
            ignorePreflight: z.boolean().optional(),
        },
    }, async (input) => {
        const result = await d.sessions.create({ ...input, createdBy: decider(), batch: input.batch ?? defaultBatch() });
        return result.ok ? json(result) : fail(result.error, result.preflight !== undefined ? { preflight: result.preflight } : {});
    });
    mcp.registerTool('djy_session_list', { description: 'List dispatched sessions with their desktop state (active / archived from the sidebar / missing). Reuse active ones for follow-up work.' }, async () => json(d.registry.list().map(s => ({ ...s, desktop: d.registry.desktopState(s.sessionId) }))));
    mcp.registerTool('djy_session_close', {
        description: 'Cancel and close a dispatched session. Do NOT close a session just because a task finished: sessions are meant to be reused — later tasks on the same session queue in order and keep its context, and the user can watch it in the desktop app. Close only when the user asks, when the work stream for that role is over, or to free a slot under maxSessions.',
        inputSchema: { sessionId: z.string() },
    }, async ({ sessionId }) => (await d.sessions.close(sessionId)) ? json({ closed: sessionId }) : fail(`unknown session ${sessionId}`));
    mcp.registerTool('djy_task_submit', {
        description: 'Queue a task on a dispatched session. Tasks on one session run in order and share its context — reuse an existing session (djy_session_list) for follow-up work instead of creating a new one. Declare exclusive resources (e.g. ["bench"] for benchmarks) — the task starts only after holding them, and benchmark commands are denied without the bench lease.',
        inputSchema: {
            sessionId: z.string(),
            prompt: z.string(),
            title: z.string().optional(),
            resources: z.array(z.string()).optional(),
        },
    }, async (input) => {
        const desktop = d.registry.desktopState(input.sessionId);
        if (desktop === 'archived')
            return fail('this session was archived in the desktop sidebar; unarchive it there (or in the Dujiangyan panel) or create a new session');
        if (desktop === 'missing')
            return fail('this session no longer exists in any desktop workspace; create a new session');
        try {
            const rec = d.tasks.submit(input);
            return json({ taskId: rec.id, status: rec.status });
        }
        catch (err) {
            return fail(err instanceof Error ? err.message : String(err));
        }
    });
    mcp.registerTool('djy_task_get', {
        description: 'Get one task: status, held resources, result (final text tail, tool calls, JSON summary) or error.',
        inputSchema: { taskId: z.string() },
    }, async ({ taskId }) => {
        const rec = d.tasks.get(taskId);
        return rec !== undefined ? json(rec) : fail(`unknown task ${taskId}`);
    });
    mcp.registerTool('djy_task_list', {
        description: 'List tasks, optionally by session or status.',
        inputSchema: {
            sessionId: z.string().optional(),
            status: z.enum(['queued', 'waiting_resources', 'waiting_slot', 'running', 'done', 'error', 'cancelled']).optional(),
        },
    }, async ({ sessionId, status }) => json(d.tasks.list({
        ...sessionId !== undefined ? { sessionId } : {},
        ...status !== undefined ? { status: status } : {},
    }).map(t => ({ id: t.id, sessionId: t.sessionId, title: t.title, status: t.status, resources: t.resources, holds: t.holds, error: t.error }))));
    mcp.registerTool('djy_task_cancel', {
        description: 'Cancel a queued or running task.',
        inputSchema: { taskId: z.string() },
    }, async ({ taskId }) => (await d.tasks.cancel(taskId)) ? json({ cancelled: taskId }) : fail(`task ${taskId} is unknown or already finished`));
    mcp.registerTool('djy_events_watch', {
        description: 'Long-poll the event log: returns events after `cursor` (gate decisions, pending approvals, task progress, route switches, leases). Pass the returned cursor next time. waitSeconds ≤ 55.',
        // Defaults are applied in the handler: the SDK validates the raw shape and
        // reports `.default()` fields as missing when a client omits them.
        inputSchema: {
            cursor: z.number().int().min(0).optional(),
            waitSeconds: z.number().min(0).max(55).optional(),
            limit: z.number().int().min(1).max(500).optional(),
        },
    }, async ({ cursor, waitSeconds, limit }, extra) => json(await d.events.wait(cursor ?? 0, (waitSeconds ?? 25) * 1000, extra.signal, limit ?? 200)));
    mcp.registerTool('djy_approvals_list', {
        description: 'List tool calls waiting for an approver decision (escalated by the gate rules or sandbox escalations).',
    }, async () => json(d.approvals.list()));
    mcp.registerTool('djy_approval_decide', {
        description: 'Decide one pending approval. The first decision wins. Deny with a reason the worker can act on. Escalate irreversible or outward-facing actions to the human instead of allowing them.',
        inputSchema: {
            id: z.string(),
            decision: z.enum(['allow', 'deny']),
            reason: z.string().min(1),
        },
    }, async ({ id, decision, reason }) => d.approvals.decide(id, decision, reason, decider())
        ? json({ id, decision })
        : fail(`approval ${id} is unknown or already settled`));
    mcp.registerTool('djy_locks_list', { description: 'List held leases and queue lengths.' }, async () => json(d.leases.list().map(l => ({ ...l, queued: d.leases.queued(l.name) }))));
}
export function startMcpServer(deps) {
    const transports = new Map();
    const server = http.createServer(async (req, res) => {
        const rejection = checkRequest(req, deps.token);
        if (rejection !== undefined) {
            res.writeHead(rejection.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: rejection.message }, id: null }));
            return;
        }
        if (!(req.url ?? '').startsWith('/mcp')) {
            res.writeHead(404).end();
            return;
        }
        const sid = req.headers['mcp-session-id'];
        const existing = typeof sid === 'string' ? transports.get(sid) : undefined;
        try {
            if (existing !== undefined) {
                await existing.handleRequest(req, res);
                return;
            }
            if (req.method === 'POST' && sid === undefined) {
                const mcp = new McpServer({ name: 'dujiangyan-dispatch', version: VERSION });
                registerTools(mcp, deps);
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    onsessioninitialized: id => { transports.set(id, transport); },
                });
                transport.onclose = () => {
                    if (transport.sessionId !== undefined)
                        transports.delete(transport.sessionId);
                };
                await mcp.connect(transport);
                await transport.handleRequest(req, res);
                return;
            }
            res.writeHead(sid !== undefined ? 404 : 400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: sid !== undefined ? 'unknown MCP session' : 'initialize first' }, id: null }));
        }
        catch (err) {
            if (!res.headersSent)
                res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: err instanceof Error ? err.message : String(err) }, id: null }));
        }
    });
    server.listen(deps.config.port, deps.config.host);
    const url = `http://${deps.config.host}:${deps.config.port}/mcp`;
    return {
        url,
        close: async () => {
            for (const t of transports.values())
                await t.close().catch(() => { });
            transports.clear();
            await new Promise(resolve => server.close(() => resolve()));
        },
    };
}
