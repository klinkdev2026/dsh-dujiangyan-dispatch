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
  whenIdle(): Promise<void>
  cancel(): void
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
      signal?: AbortSignal
    }): AsyncIterable<StreamChunk>
  }
}

export interface PermissionPresets {
  set(session: HostSession, name: string): void
  current(session: HostSession): string
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
