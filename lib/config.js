/**
 * Plugin configuration (the `dujiangyan-dispatch` row in a profile patch) and
 * its defaults. Every field is optional in the patch.
 */
import path from 'node:path';
import { DEFAULT_AI_APPROVAL, judgesFromRoster } from "./ai-approval.js";
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
    const roster = { ...DEFAULT_ROSTER, ...config.roster };
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
        fallbackToHuman: config.fallbackToHuman ?? false,
        roster,
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
        startupRetryDelaysMs: config.startupRetryDelaysMs ?? [1000, 3000],
        aiApproval: {
            enabled: config.aiApproval?.enabled ?? DEFAULT_AI_APPROVAL.enabled,
            judges: config.aiApproval?.judges ?? judgesFromRoster(roster),
            scope: 'wide',
            timeoutMs: config.aiApproval?.timeoutMs ?? DEFAULT_AI_APPROVAL.timeoutMs,
            maxPerSessionPer10Min: config.aiApproval?.maxPerSessionPer10Min ?? DEFAULT_AI_APPROVAL.maxPerSessionPer10Min,
        },
        quietMode: {
            enabled: config.quietMode?.enabled ?? true,
            patterns: config.quietMode?.patterns ?? [],
            maxWaitMs: config.quietMode?.maxWaitMs ?? 30 * 60_000,
        },
        denyBreaker: {
            enabled: config.denyBreaker?.enabled ?? true,
            consecutiveDenies: config.denyBreaker?.consecutiveDenies ?? 3,
            windowDenies: config.denyBreaker?.windowDenies ?? 6,
            windowSize: config.denyBreaker?.windowSize ?? 10,
        },
        watchdog: {
            intervalMs: config.watchdog?.intervalMs ?? 15_000,
            steerAfterMs: config.watchdog?.steerAfterMs ?? 60_000,
            warnAfterMs: config.watchdog?.warnAfterMs ?? [3 * 60_000, 8 * 60_000],
            stallAfterMs: config.watchdog?.stallAfterMs ?? 10 * 60_000,
            orchestratorAbsentMs: config.watchdog?.orchestratorAbsentMs ?? 3 * 60_000,
        },
    };
}
