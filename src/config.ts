/**
 * Plugin configuration (the `dujiangyan-dispatch` row in a profile patch) and
 * its defaults. Every field is optional in the patch.
 */
import path from 'node:path'
import { DEFAULT_LIMIT, type ProviderLimit } from './limiter.ts'
import { canonicalPath, dshHome } from './paths.ts'
import type { RuleConfig } from './rules.ts'

/** One route of a role's model chain: the first healthy entry serves requests. */
export interface RouteEntry {
  readonly provider: string
  readonly model: string
  readonly effort?: string
}

export interface Config {
  host?: string
  port?: number
  stateDir?: string
  workspaceRoots?: string[]
  permissionPreset?: string
  agentPreset?: string
  approvalTimeoutMs?: number
  /** When an approval times out, hand root sessions to the desktop's own approval prompt. */
  fallbackToHuman?: boolean
  roster?: Record<string, RouteEntry[]>
  limits?: { defaults?: Partial<ProviderLimit>; providers?: Record<string, Partial<ProviderLimit>> }
  /** Optional experiment: stagger task starts behind a leader to warm the provider's prefix cache. Off by default. */
  stagger?: { enabled?: boolean; baseMs?: number; jitterMs?: number; leaderWaitMs?: number }
  /** Cap on sessions that exist at once; 0 (default) = unlimited. Idle sessions cost nothing. */
  maxSessions?: number
  /**
   * Optional cap on sessions running a task at the same time (local load only); 0 (default) = unlimited.
   * API pressure is NOT controlled here: every request already passes the per-provider admission
   * control (concurrency cap, spacing + jitter, 429 backoff, breaker), so any number of sessions
   * can run and their requests are staggered onto each key.
   */
  maxActiveSessions?: number
  rules?: RuleConfig
  /** Run the workspace preflight before creating a session (Windows integrity labels). */
  preflight?: boolean
}

export interface ResolvedConfig {
  readonly host: string
  readonly port: number
  readonly stateDir: string
  readonly workspaceRoots: readonly string[]
  readonly permissionPreset: string
  readonly agentPreset: string
  readonly approvalTimeoutMs: number
  readonly fallbackToHuman: boolean
  readonly roster: Readonly<Record<string, readonly RouteEntry[]>>
  readonly limitFor: (provider: string) => ProviderLimit
  readonly stagger: { readonly enabled: boolean; readonly baseMs: number; readonly jitterMs: number; readonly leaderWaitMs: number }
  readonly maxSessions: number
  readonly maxActiveSessions: number
  readonly rules: RuleConfig
  readonly preflight: boolean
}

/**
 * At personal scale (5–10 agents) the binding limits are the user's own keys —
 * gateway keys often allow only a few concurrent requests — not the provider's
 * capacity. Defaults therefore only cap concurrency per key; the RPM window is
 * off unless a key documents one.
 */
export const DEFAULT_PROVIDER_LIMITS: Readonly<Record<string, Partial<ProviderLimit>>> = {
  'deepseek-official': { maxConcurrent: 8 },
}

/** Lenient defaults: no RPM window, a small spacing so retries never fire in the same instant. */
const PERSONAL_SCALE_LIMIT: Partial<ProviderLimit> = { rpm: 0, minSpacingMs: 150, jitterMs: 250 }

export const DEFAULT_ROSTER: Readonly<Record<string, readonly RouteEntry[]>> = {
  implementer: [{ provider: 'deepseek-official', model: 'deepseek-flash' }],
  reviewer: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro' }],
  planner: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro' }],
}

export function resolveConfig(config: Config = {}): ResolvedConfig {
  const limits = config.limits ?? {}
  const defaults = { ...DEFAULT_LIMIT, ...PERSONAL_SCALE_LIMIT, ...limits.defaults }
  const providers = { ...DEFAULT_PROVIDER_LIMITS, ...limits.providers }
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
  }
}
