/**
 * The escalation queue between the gate and an external approver.
 *
 * A pending approval waits until the first `decide()` (any approver: Claude
 * Code, Codex, a human tool), its timeout, or the tool call's abort signal.
 * The first decision wins; later ones are rejected so two approvers can never
 * flip a call.
 */
import { randomUUID } from 'node:crypto'
import type { AiOpinion } from './ai-approval.ts'
import type { ApprovalContext } from './approval-context.ts'
import type { EventLog } from './events.ts'

export type ApprovalDecision = 'allow' | 'deny'
export type ApprovalResult =
  | { readonly kind: 'allow'; readonly reason: string; readonly decider: string }
  | { readonly kind: 'deny'; readonly reason: string; readonly decider: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'cancelled' }

export interface ApprovalRequest {
  readonly sessionId: string
  readonly taskId?: string
  readonly tool: string
  /** Bounded, secret-free summary of the arguments shown to the approver. */
  readonly summary: string
  /** True when `summary` was cut at the bound: the approver has not seen the whole call. */
  readonly truncated?: boolean
  readonly rule: string
  readonly reason: string
  readonly cwd: string
  /** `pre-execute` (a tool call) or `sandbox` (an escalation inside a tool body). */
  readonly origin: 'pre-execute' | 'sandbox'
  /** Task, worker narration and recent calls, so the approver can judge the call in context (untrusted text). */
  readonly context?: ApprovalContext
  /** Set on host sandbox escalations: what approving actually grants (shown as a strong warning). */
  readonly danger?: string
}

/** What the AI judges said about a pending call (attached while it waits for a human). */
export interface AiAnnotation {
  /** `judging` while the judges run; `split` when they did not all agree (or one said "human"/failed). */
  readonly status: 'judging' | 'split'
  readonly opinions: readonly AiOpinion[]
}

export interface PendingApproval extends ApprovalRequest {
  readonly id: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly ai?: AiAnnotation
}

interface Entry {
  pending: PendingApproval
  readonly settle: (result: ApprovalResult) => void
  /** Aborted when the approval settles, so work done on its behalf (AI judges) stops. */
  readonly settled: AbortController
  /** Whether `approval/pending` has been written to the event log (it waits while AI judges decide). */
  published: boolean
}

/** What became of an approval that is no longer pending (kept briefly, e.g. to deliver a late note). */
export interface SettledApproval {
  readonly id: string
  readonly sessionId: string
  readonly taskId?: string
  readonly result: ApprovalResult['kind']
  readonly decider?: string
  readonly at: string
}

export interface RequestOptions {
  /**
   * Hold the `approval/pending` event back (AI judges are deciding): `publish()` writes it, at the
   * latest after `publishAfterMs`. An approval the judges settle never reaches the orchestrator's stream.
   */
  readonly deferEvent?: boolean
  readonly publishAfterMs?: number
}

const MAX_SETTLED = 500

export class ApprovalQueue {
  private readonly entries = new Map<string, Entry>()
  private readonly recentlySettled = new Map<string, SettledApproval>()

  private readonly events: EventLog
  private readonly audit: (record: Record<string, unknown>) => void
  private readonly now: () => number

  constructor(events: EventLog, audit: (record: Record<string, unknown>) => void, now: () => number = () => Date.now()) {
    this.events = events
    this.audit = audit
    this.now = now
  }

  /** Park one request until decided, timed out, or aborted. `onCreated` receives the id once it is listed. */
  request(req: ApprovalRequest, timeoutMs: number, signal?: AbortSignal, onCreated?: (id: string) => void, opts: RequestOptions = {}): Promise<ApprovalResult> {
    if (signal?.aborted === true) return Promise.resolve({ kind: 'cancelled' })
    const id = `apr_${randomUUID().slice(0, 12)}`
    const created = this.now()
    const pending: PendingApproval = {
      ...req,
      reason: redactSecrets(req.reason),
      id,
      createdAt: new Date(created).toISOString(),
      expiresAt: new Date(created + timeoutMs).toISOString(),
    }
    const settled = new AbortController()
    return new Promise<ApprovalResult>(resolve => {
      let done = false
      const settle = (result: ApprovalResult) => {
        if (done) return
        done = true
        settled.abort()
        clearTimeout(timer)
        clearTimeout(publishTimer)
        signal?.removeEventListener('abort', onAbort)
        const entry = this.entries.get(id)
        this.entries.delete(id)
        const decider = result.kind === 'allow' || result.kind === 'deny' ? result.decider : undefined
        const aiSettled = decider?.startsWith('ai:') === true
        // Not yet announced and not settled by the judges: announce it now, so the stream stays consistent.
        if (entry !== undefined && !entry.published && !aiSettled) this.events.append('approval/pending', { ...entry.pending })
        this.recentlySettled.set(id, { id, sessionId: req.sessionId, ...req.taskId !== undefined ? { taskId: req.taskId } : {}, result: result.kind, ...decider !== undefined ? { decider } : {}, at: new Date(this.now()).toISOString() })
        if (this.recentlySettled.size > MAX_SETTLED) this.recentlySettled.delete(this.recentlySettled.keys().next().value as string)
        this.audit({ type: 'approval/settled', id, sessionId: req.sessionId, tool: req.tool, rule: req.rule, ...result })
        this.events.append('approval/settled', { id, sessionId: req.sessionId, taskId: req.taskId, tool: req.tool, result: result.kind, ...aiSettled ? { aiSettled: true, decider } : {} })
        resolve(result)
      }
      const onAbort = () => settle({ kind: 'cancelled' })
      const timer = setTimeout(() => settle({ kind: 'timeout' }), timeoutMs)
      timer.unref?.()
      const defer = opts.deferEvent === true
      const publishTimer = defer ? setTimeout(() => this.publish(id), opts.publishAfterMs ?? 60_000) : undefined
      publishTimer?.unref?.()
      signal?.addEventListener('abort', onAbort, { once: true })
      this.entries.set(id, { pending, settle, settled, published: !defer })
      this.audit({ type: 'approval/pending', ...pending })
      if (!defer) this.events.append('approval/pending', { ...pending })
      onCreated?.(id)
    })
  }

  /** A signal that aborts when the approval settles (any decider, timeout or cancel); undefined once settled. */
  settledSignal(id: string): AbortSignal | undefined {
    return this.entries.get(id)?.settled.signal
  }

  list(): PendingApproval[] {
    return [...this.entries.values()].map(e => e.pending)
  }

  /** Write a deferred `approval/pending` event (with the judges' opinions attached by then). */
  publish(id: string): void {
    const entry = this.entries.get(id)
    if (entry === undefined || entry.published) return
    entry.published = true
    this.events.append('approval/pending', { ...entry.pending })
  }

  /** The outcome of an approval settled recently (the last few hundred), if any. */
  settled(id: string): SettledApproval | undefined {
    return this.recentlySettled.get(id)
  }

  /** Decide a pending approval. Returns false when it is unknown or already settled. */
  decide(id: string, decision: ApprovalDecision, reason: string, decider: string): boolean {
    const entry = this.entries.get(id)
    if (entry === undefined) return false
    entry.settle({ kind: decision, reason, decider })
    return true
  }

  /** Attach the AI judges' opinions to a pending approval. Returns false when it is no longer pending. */
  annotate(id: string, ai: AiAnnotation): boolean {
    const entry = this.entries.get(id)
    if (entry === undefined) return false
    entry.pending = { ...entry.pending, ai }
    return true
  }

  /** Cancel every pending approval (plugin disposal). */
  cancelAll(): void {
    for (const entry of [...this.entries.values()]) entry.settle({ kind: 'cancelled' })
  }
}

/**
 * Bound on the approver-facing summary. A shell command has to be read in full to be judged
 * (a real run had `Remove-Item …; cargo test` hidden past a 1200-character cut), so the bound
 * is generous and a cut is flagged rather than silent.
 */
export const SUMMARY_MAX = 16_000

/** Summarize tool arguments for an approver: bounded length, likely secrets masked. */
export function summarizeArgs(args: Readonly<Record<string, unknown>>, max = SUMMARY_MAX): string {
  return summarizeForApproval(args, max).summary
}

const SECRET_KEY_WORDS = new Set(['key', 'apikey', 'token', 'secret', 'password', 'passwd', 'pwd', 'authorization', 'auth', 'credential', 'credentials'])

/** Whole-word match on the argument name (api_key, apiKey, X-Auth-Token), so monkey / keyboard / max_tokens stay visible. */
export function isSecretKey(key: string): boolean {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).some(w => SECRET_KEY_WORDS.has(w))
}

export function summarizeForApproval(args: Readonly<Record<string, unknown>>, max = SUMMARY_MAX): { summary: string; truncated: boolean } {
  const masked = redactSecrets(JSON.stringify(args, (key, value: unknown) => {
    if (isSecretKey(key)) return '***'
    if (key === 'content' && typeof value === 'string' && value.length > 200) return `${value.slice(0, 200)}… (${value.length} chars)`
    return value
  }))
  if (masked.length <= max) return { summary: masked, truncated: false }
  // Never cut between the halves of a surrogate pair (emoji, rare CJK): a lone half is invalid UTF-16.
  const cut = /[\uD800-\uDBFF]/.test(masked.charAt(max - 1)) ? max - 1 : max
  return { summary: `${masked.slice(0, cut)}…`, truncated: true }
}

/**
 * Secrets written inline in a command string (the JSON-key masking above only sees argument
 * names): `--token X`, `--api-key=X`, `KEY=…`/`TOKEN=…`/`SECRET=…`/`PASSWORD=…` assignments,
 * `Authorization: Bearer X`, and provider-style keys (`sk-…`, GitHub/Slack tokens). Applied to
 * everything an approver, a judge, the panel or the audit log sees.
 */
// The text is usually a JSON summary, so a quote inside a command appears as `\"`; values stop at
// whitespace, quotes, backslashes and shell separators.
const VALUE = String.raw`(?:\\?"[^"\\]*\\?"|'[^']*'|[^\s"'\\;&|]+)`
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [new RegExp(String.raw`(authorization\s*[:=]\s*(?:bearer|basic|token)\s+)[^\s"'\\]+`, 'gi'), '$1***'],
  [new RegExp(String.raw`(--?(?:api[-_]?key|access[-_]?key|secret(?:[-_]key)?|token|auth[-_]?token|password|passwd|pwd)(?:\s+|=))${VALUE}`, 'gi'), '$1***'],
  [new RegExp(String.raw`(\b[A-Za-z0-9_]*(?:API_?KEY|ACCESS_?KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*\s*=\s*)${VALUE}`, 'gi'), '$1***'],
  [/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-***'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '***'], // a JWT
  [/\b(?:ghp|gho|ghu|ghs|github_pat|xox[abprs])_[A-Za-z0-9_]{10,}/g, '***'],
]

export function redactSecrets(text: string): string {
  let out = text
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement)
  return out
}
