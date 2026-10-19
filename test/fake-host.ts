/**
 * A minimal stand-in for the Harness host: an event bus with emit/waterfall
 * dispatch, agents that "run" a scripted turn when they receive a followup,
 * and an llm service. Only the behavior the plugin relies on is modeled.
 */
import type { HostAgent, HostContext, HostSession, PreToolDecision, StreamChunk } from '../src/host.ts'

type Listener = (...args: any[]) => any

export interface ScriptStep {
  readonly tool: string
  readonly args: Record<string, unknown>
  /** Instead of a tool call: ask the user these questions through the agent-scoped waterfall. */
  readonly ask?: ReadonlyArray<{ id: string; question: string; options?: Array<{ label: string }> }>
  /** Pause this long before the step (lets a test act while the turn runs). */
  readonly waitMs?: number
  /** Assistant text the worker emits before this call (its narration). */
  readonly say?: string
}

export class FakeHost {
  readonly listeners = new Map<string, Listener[]>()
  readonly agentsById = new Map<string, FakeAgent>()
  readonly presets = new Map<string, string>()
  readonly validRoutes = new Set<string>(['deepseek-official/deepseek-flash', 'relay/model-b', 'deepseek-official/deepseek-v4-pro'])
  effects: Array<() => void> = []
  scripts = new Map<string, ScriptStep[]>() // keyed by prompt substring
  /** The next N turns fail before running, like the first turn after a desktop restart did. */
  startupFailures = 0
  /** Every cold resume and the agent options it carried. */
  readonly resumeCalls: Array<{ id: string; agentOptions: { provider?: string; model?: string } | undefined }> = []

  readonly ctx: HostContext = {
    on: (name, listener, options) => {
      const list = this.listeners.get(name) ?? []
      if (options?.prepend === true) list.unshift(listener)
      else list.push(listener)
      this.listeners.set(name, list)
      return () => {
        const l = this.listeners.get(name) ?? []
        const i = l.indexOf(listener)
        if (i >= 0) l.splice(i, 1)
      }
    },
    get: name => {
      if (name === 'permissionPresets') return { set: (s: HostSession, p: string) => this.presets.set(s.id, p), current: (s: HostSession) => this.presets.get(s.id) ?? 'workspace-write' }
      if (name === 'agentPresets') return { mount: async () => ({}) }
      if (name === 'approval') return { overrideOf: (s: HostSession) => (this.agentsById.get(s.id)?.session.header.parentSession !== undefined ? 'never' : 'ask') }
      return undefined
    },
    effect: execute => {
      this.effects.push(execute())
      return undefined
    },
    agents: {
      create: async options => {
        const agent = new FakeAgent(this, options.sessionId, options.meta?.cwd ?? '', undefined, options.agentOptions ?? {})
        await options.setup?.(agent.agentCtx, agent)
        this.agentsById.set(agent.session.id, agent)
        return { agent, dispose: () => {} }
      },
      // A cold resume keeps only what the caller re-sends: no agent options means no model.
      resume: async options => {
        this.resumeCalls.push({ id: options.resumeSessionId, agentOptions: options.agentOptions })
        const agent = new FakeAgent(this, options.resumeSessionId, '', undefined, options.agentOptions ?? {})
        await options.setup?.(agent.agentCtx, agent)
        this.agentsById.set(agent.session.id, agent)
        return { agent, dispose: () => {} }
      },
      get: id => this.agentsById.get(id),
    },
    llm: {
      listProviders: () => [{ id: 'deepseek-official' }, { id: 'relay' }],
      listModels: async p => [...this.validRoutes].filter(r => r.startsWith(`${p}/`)).map(r => ({ id: r.split('/')[1] as string })),
      resolveCallConfig: async c => {
        if (!this.validRoutes.has(`${c.provider}/${c.model}`)) throw new Error('NO_ADAPTER')
        return c
      },
      // Direct calls go through the llm/stream waterfall like the real service.
      stream: options => this.streamThrough(options.provider, options.model, options.signal, options.messages.map(m => m.content.map(c => c.text).join('')).join(' '), options),
      resolveModelInfo: async (provider, model) => {
        const efforts = this.reasoningEfforts.get(`${provider}/${model}`)
        return efforts !== undefined ? { reasoning: { efforts: efforts.map(id => ({ id })) } } : {}
      },
    },
  }

  /** Routes that are listed but fail like a gateway with the wrong API dialect did (400, dialect mismatch). */
  readonly brokenRoutes = new Set<string>()

  /**
   * Scripted replies for direct model calls (e.g. AI approval judges), keyed `provider/model`; `'hang'` never answers.
   * An array is consumed one reply per call. A reply `think:<text>|<answer>` streams <text> as reasoning first.
   */
  readonly modelReplies = new Map<string, string | string[]>()
  /** Routes that reject any temperature override, like a model that only allows its default. */
  readonly fixedTemperatureRoutes = new Set<string>()
  /** Selectable reasoning efforts per route (least first), for resolveModelInfo. */
  readonly reasoningEfforts = new Map<string, string[]>()
  /** Every direct model call that had a scripted reply, in order, with the call options. */
  readonly modelCalls: Array<{ route: string; prompt: string; options?: { temperature?: number; reasoningEffort?: string; maxTokens?: number } }> = []

  private streamThrough(provider: string, model: string, signal?: AbortSignal, prompt = '', options?: { temperature?: number; reasoningEffort?: string; maxTokens?: number }): AsyncIterable<StreamChunk> {
    const list = this.listeners.get('llm/stream') ?? []
    const broken = this.brokenRoutes.has(`${provider}/${model}`)
    const scripted = this.modelReplies.get(`${provider}/${model}`)
    const reply = Array.isArray(scripted) ? scripted.shift() : scripted
    if (reply !== undefined) {
      this.modelCalls.push({ route: `${provider}/${model}`, prompt, ...options !== undefined ? { options: { temperature: options.temperature, reasoningEffort: options.reasoningEffort, maxTokens: options.maxTokens } } : {} })
    }
    const refusesTemperature = this.fixedTemperatureRoutes.has(`${provider}/${model}`) && options?.temperature !== undefined
    const base = async function* (): AsyncGenerator<StreamChunk> {
      if (refusesTemperature) {
        yield { type: 'finish', reason: { kind: 'error', failure: { status: 400, code: 'BAD_REQUEST', message: 'invalid temperature: only 1 is allowed for this model' } } }
        return
      }
      if (reply === 'hang') {
        await new Promise<void>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      }
      if (reply !== undefined && reply.startsWith('think:')) {
        const [thought, answer] = reply.slice(6).split('|')
        yield { type: 'reasoning-delta', text: thought ?? '' } as StreamChunk
        yield { type: 'text-delta', text: answer ?? '' } as StreamChunk
      } else if (reply !== undefined) yield { type: 'text-delta', text: reply } as StreamChunk
      if (broken) {
        yield { type: 'finish', reason: { kind: 'error', failure: { status: 400, code: 'BAD_REQUEST', message: 'Invalid JSON payload received. Unknown name "anthropic_version"' } } }
        return
      }
      yield { type: 'usage', usage: { input: 5, output: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const call = (i: number): AsyncIterable<StreamChunk> => {
      const l = list[i]
      return l === undefined ? base() : l({ provider, model }, () => call(i + 1))
    }
    return call(0)
  }

  emit(name: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(name) ?? []) l(...args)
  }

  async waterfall<T>(name: string, args: unknown[], final: () => Promise<T>): Promise<T> {
    const list = this.listeners.get(name) ?? []
    const call = (i: number): Promise<T> => {
      const l = list[i]
      if (l === undefined) return final()
      return Promise.resolve(l(...args, () => call(i + 1)))
    }
    return call(0)
  }

  /** Run one tool call through the pre-execute chain, as the tools registry does. */
  async preExecute(agent: HostAgent, tool: string, args: Record<string, unknown>, signal = new AbortController().signal): Promise<PreToolDecision> {
    return this.waterfall<PreToolDecision>('tools/pre-execute', [{ callId: `c${Math.random()}`, name: tool, arguments: args, agent, signal }], async () => ({ kind: 'allow' }))
  }

  /** Raise a host `approval/request` (a sandbox escalation or a desktop ask), as the tool runtime does. */
  async approvalRequest(agent: HostAgent, toolName: string, reason?: string, callId?: string): Promise<string> {
    return this.waterfall<string>('approval/request', [{ agent, toolName, ...callId !== undefined ? { callId } : {}, ...reason !== undefined ? { reason } : {} }], async () => 'unavailable')
  }

  /** Stream one model call through `llm/stream`, ending with the given finish reason. */
  async stream(provider: string, model: string, finish: { kind: string; failure?: unknown }): Promise<StreamChunk[]> {
    const list = this.listeners.get('llm/stream') ?? []
    const base = async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'usage', usage: { input: 100, output: 10, cacheRead: 80 } }
      yield { type: 'finish', reason: finish }
    }
    const call = (i: number): AsyncIterable<StreamChunk> => {
      const l = list[i]
      return l === undefined ? base() : l({ provider, model }, () => call(i + 1))
    }
    const out: StreamChunk[] = []
    for await (const c of call(0)) out.push(c)
    return out
  }

  dispose(): void {
    for (const e of this.effects) e()
  }
}

export class FakeAgent implements HostAgent {
  readonly session: HostSession
  private idle: Promise<void> = Promise.resolve()
  readonly decisions: Array<{ tool: string; decision: PreToolDecision }> = []
  cancelled = false
  readonly host: FakeHost
  readonly options: { provider?: string; model?: string }
  /** Agent-scoped context: listeners installed in session setup (e.g. user-questions/request). */
  readonly agentListeners = new Map<string, Listener[]>()
  readonly agentCtx = {
    on: (name: string, listener: Listener, opts?: { prepend?: boolean }) => {
      const list = this.agentListeners.get(name) ?? []
      if (opts?.prepend === true) list.unshift(listener)
      else list.push(listener)
      this.agentListeners.set(name, list)
      return () => {}
    },
  }
  /** Messages steered into the running turn. */
  readonly steered: unknown[] = []

  constructor(host: FakeHost, id: string, cwd: string, parentSession: string | undefined, options: { provider?: string; model?: string }) {
    this.host = host
    this.options = options
    this.session = { id, header: { id, cwd, ...parentSession !== undefined ? { parentSession } : {} } }
  }

  spawnChild(id: string): FakeAgent {
    const child = new FakeAgent(this.host, id, this.session.header.cwd ?? '', this.session.id, this.options)
    this.host.agentsById.set(id, child)
    return child
  }

  readonly received: unknown[] = []

  followup(message: unknown): void {
    this.received.push(message)
    const source = (message as { source?: { kind?: string } }).source
    if (source?.kind === undefined || source.kind === 'plugin') {
      // Mirror session format v4: the turn fails, the agent reports an error and goes idle.
      setTimeout(() => this.host.emit('agent/error', { agent: this, error: new Error('format v4 message requires a producer-owned source kind') }), 5)
      return
    }
    if (this.host.startupFailures > 0) {
      this.host.startupFailures--
      setTimeout(() => this.host.emit('agent/error', { agent: this, error: new Error('prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")') }), 5)
      return
    }
    const text = JSON.stringify(message)
    const script = [...this.host.scripts.entries()].find(([k]) => text.includes(k))?.[1] ?? []
    // Like the real loop, the agent is still idle when followup returns and starts running a moment later.
    setTimeout(() => {
      this.running = true
      this.idle = (async () => {
        this.host.emit('agent/status', { agent: this, status: 'running' })
        await this.run(script)
        this.running = false
        this.host.emit('agent/status', { agent: this, status: 'idle' })
      })()
    }, 5)
  }

  private running = false

  /** Like the real host: cancelling a turn aborts the tool call it is waiting on (pre-execute, approvals). */
  private turnAbort = new AbortController()

  private async run(script: ScriptStep[]): Promise<void> {
    this.cancelled = false
    this.turnAbort = new AbortController()
    await (async () => {
      for (const step of script) {
        if (step.waitMs !== undefined) await new Promise(r => setTimeout(r, step.waitMs))
        if (this.cancelled) {
          this.host.emit('agent/error', { agent: this, error: new Error('turn aborted') })
          return
        }
        if (step.ask !== undefined) {
          const asker = this.agentListeners.get('user-questions/request')?.[0]
          try {
            await asker?.({ questions: step.ask }, async () => ({ answers: [] }))
          } catch (err) {
            this.host.emit('agent/error', { agent: this, error: err })
          }
          if (this.cancelled) return
          continue
        }
        if (step.say !== undefined) {
          this.host.emit('session/event', this.session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: step.say }] } } })
        }
        this.host.emit('session/event', this.session, { type: 'tool/call', data: { name: step.tool, arguments: JSON.stringify(step.args) } })
        const decision = await this.host.preExecute(this, step.tool, step.args, this.turnAbort.signal)
        this.decisions.push({ tool: step.tool, decision })
        if (this.cancelled) {
          this.host.emit('agent/error', { agent: this, error: new Error('turn aborted') })
          return
        }
        this.host.emit('session/event', this.session, { type: 'tool/result', data: {} })
      }
      this.host.emit('session/event', this.session, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: 'done.\n{"changes":"wrote data","verification":"listed files","leftovers":""}' }] } },
      })
    })()
  }

  /** Like the real agent: resolves immediately while not running. */
  whenIdle(): Promise<void> {
    return this.running ? this.idle : Promise.resolve()
  }

  cancelCauses: unknown[] = []
  cancel(cause?: unknown): void {
    if (cause == null) throw new Error('cancel() needs a cause: the host logs it as the turn/end reason')
    this.cancelCauses.push(cause)
    this.cancelled = true
    this.turnAbort.abort(cause)
  }

  steer(message: unknown): void {
    this.steered.push(message)
  }
}
