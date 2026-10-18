/**
 * Plugin configuration (the `dujiangyan-dispatch` row in a profile patch) and
 * its defaults. Every field is optional in the patch.
 */
import path from 'node:path';
import { DEFAULT_LIMIT } from "./limiter.js";
import { canonicalPath, dshHome } from "./paths.js";
/**
 * At personal scale (5–10 agents) the binding limits are the user's own keys —
 * gateway keys often allow only a few concurrent requests — not the provider's
 * capacity. Defaults therefore only cap concurrency per key; the RPM window is
 * off unless a key documents one.
 */
export const DEFAULT_PROVIDER_LIMITS = {
    'deepseek-official': { maxConcurrent: 8 },
};
/** Lenient defaults: no RPM window, a small spacing so retries never fire in the same instant. */
const PERSONAL_SCALE_LIMIT = { rpm: 0, minSpacingMs: 150, jitterMs: 250 };
export const DEFAULT_ROSTER = {
    implementer: [{ provider: 'deepseek-official', model: 'deepseek-flash' }],
    reviewer: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro' }],
    planner: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro' }],
};
export function resolveConfig(config = {}) {
    const limits = config.limits ?? {};
    const defaults = { ...DEFAULT_LIMIT, ...PERSONAL_SCALE_LIMIT, ...limits.defaults };
    const providers = { ...DEFAULT_PROVIDER_LIMITS, ...limits.providers };
    return {
        host: config.host ?? '127.0.0.1',
        port: config.port ?? 8790,
        stateDir: config.stateDir ?? path.join(dshHome(), 'dujiangyan'),
        workspaceRoots: (config.workspaceRoots ?? []).map(root => canonicalPath(root)),
        permissionPreset: config.permissionPreset ?? 'workspace-write',
        agentPreset: config.agentPreset ?? 'standard',
        approvalTimeoutMs: config.approvalTimeoutMs ?? 15 * 60_000,
        fallbackToHuman: config.fallbackToHuman ?? true,
        roster: { ...DEFAULT_ROSTER, ...config.roster },
        limitFor: provider => ({ ...defaults, ...providers[provider] }),
        stagger: {
            enabled: config.stagger?.enabled ?? false,
            baseMs: config.stagger?.baseMs ?? 3000,
            jitterMs: config.stagger?.jitterMs ?? 2000,
            leaderWaitMs: config.stagger?.leaderWaitMs ?? 20_000,
        },
        maxSessions: config.maxSessions ?? 0,
        maxActiveSessions: config.maxActiveSessions ?? 0,
        rules: config.rules ?? {},
        preflight: config.preflight ?? true,
    };
}
