/**
 * The slice of the DeepSeek Harness host this plugin touches, typed
 * structurally. The host services are injected by Cordis at runtime; keeping
 * these shapes local avoids compiling against a dozen host packages whose
 * private details change between release candidates. Every member used here
 * was checked against deepseek-harness 0.2.1-rc.2 (commit 687f282).
 */

export interface SessionHeader {
  readonly id: string
  readonly cwd?: string
  readonly parentSession?: string
  readonly origin?: string
  readonly delegationDepth?: number
}

export interface HostSession {
  readonly id: string
  readonly header: SessionHeader
}

export interface HostAgent {
  readonly id?: string
  readonly session: HostSession
  readonly status?: string
  followup(message: unknown): void
  /** Deliver a message at the running agent's next model step (not a new turn). */
  steer?(message: unknown): void
  whenIdle(): Promise<void>
  /** The cause is required: the host records it as the turn/end reason, and the desktop chat view crashes on a null one. */
  cancel(cause: AgentCancelCause): void
}

export interface AgentHandle {
  readonly agent: HostAgent
  dispose(): Promise<void> | void
}

export interface AgentOptions {
  provider?: string
  model?: string
  reasoningEffort?: string
}

/** `tools/pre-execute` payload (core/tools/src/index.ts:327-399). */
export interface ToolExecution {
  readonly callId?: string
  readonly name: string
  readonly arguments?: unknown
  readonly agent?: HostAgent
  readonly parent?: unknown
  readonly signal: AbortSignal
}

export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string; info?: { name: string; code: string; reason?: string } }
  | { kind: 'cancel' }
  | { kind: 'ask'; reason?: string; displayReason?: { en: string; [locale: string]: string } }

/** `approval/request` payload (interaction/user-approval/src/types.ts). */
export interface ApprovalRequestEvent {
  readonly agent: HostAgent
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

/** Host AgentCancelCause (core/session types.ts); we cancel as a hook. */
export type AgentCancelCause = { readonly kind: 'user' } | { readonly kind: 'parent' } | { readonly kind: 'hook'; readonly reason: string } | { readonly kind: 'disposed' }
export const DISPATCH_CANCEL: AgentCancelCause = Object.freeze({ kind: 'hook', reason: 'dujiangyan-dispatch/cancel' })

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface LlmCallConfig {
  provider: string
  model: string
  reasoningEffort?: string
  [control: string]: unknown
}

export interface GenerateOptions {
  readonly provider?: string
  readonly model?: string
  readonly signal?: AbortSignal
}

export interface StreamChunk {
  readonly type: string
  readonly usage?: Record<string, unknown>
  readonly reason?: { readonly kind: string; readonly failure?: unknown }
}

export interface SessionEvent {
  readonly type: string
  readonly data?: unknown
}

export interface Disposable {
  (): void
}

/** The Cordis context, narrowed to what this plugin calls. */
export interface HostContext {
  on(name: string, listener: (...args: any[]) => any, options?: { prepend?: boolean }): Disposable
  get(name: string): unknown
  effect(execute: () => () => void, label?: string): unknown
  readonly agents: {
    create(options: {
      sessionId: string
      meta?: { cwd?: string; agentPreset?: string }
      agentOptions?: AgentOptions
      setup?: (agentCtx: unknown, agent: HostAgent) => Promise<void> | void
    }): Promise<AgentHandle>
    resume(options: {
      resumeSessionId: string
      agentOptions?: AgentOptions
      setup?: (agentCtx: unknown, agent: HostAgent) => Promise<void> | void
    }): Promise<AgentHandle>
    get(id: string): HostAgent | undefined
  }
  readonly llm: {
    listProviders(): ReadonlyArray<{ readonly id?: string; readonly name?: string; readonly [k: string]: unknown }>
    listModels(provider: string): Promise<ReadonlyArray<{ readonly id: string; readonly [k: string]: unknown }>>
    resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig>
    /** Direct model call (passes through the `llm/stream` waterfall, so admission control applies). */
    stream(options: {
      provider: string
      model: string
      messages: Array<{ role: 'user'; content: Array<{ type: 'text'; text: string }> }>
      maxTokens?: number
      temperature?: number
      reasoningEffort?: string
      tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
      signal?: AbortSignal
    }): AsyncIterable<StreamChunk>
    /** Exact-route model metadata, including the selectable reasoning efforts (least first). */
    resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<{ readonly reasoning?: { readonly efforts: ReadonlyArray<{ readonly id: string }> } }>
  }
}

export interface PermissionPresets {
  set(session: HostSession, name: string): void
  current(session: HostSession): string
}

/** Host sandbox policy (dsh-sandbox-policy): the effective mode of a session's calls. */
export interface SandboxPolicyService {
  resolve(request: { session?: HostSession }): { readonly mode?: string }
}

export interface ApprovalService {
  overrideOf(session: HostSession): string | undefined
}

export interface AgentPresetRegistry {
  mount(ctx: unknown, id?: string): Promise<unknown>
}

export interface SessionsService {
  get?(id: string): HostSession | undefined
}

export interface WorkspaceView {
  readonly path: string
  readonly sessionIds?: readonly string[]
  attachSession?(sessionId: string): Promise<void>
}

export interface WorkspaceRegistry {
  resolveByPath?(path: string): Promise<WorkspaceView | undefined>
  create?(path: string): Promise<WorkspaceView>
}

/** Read an optional host service without throwing when it is absent. */
export function optional<T>(ctx: HostContext, name: string): T | undefined {
  try {
    return (ctx.get(name) ?? undefined) as T | undefined
  } catch {
    return undefined
  }
}
