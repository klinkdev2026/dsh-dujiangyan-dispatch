/**
 * What an approver needs to judge a held call besides the call itself: which task it
 * serves, what the worker said it was doing, and what it did just before.
 *
 * Every string here comes from the worker (prompt echo, assistant text, its own tool
 * arguments), so it is untrusted: secrets are redacted, everything is bounded, and the
 * AI judges only ever see it inside the data fence (ai-approval.ts judgePrompt).
 */
import { redactSecrets } from './approvals.ts'

export interface RecentCall {
  /** The task the call belonged to (calls from earlier tasks are not shown). */
  readonly taskId?: string
  readonly tool: string
  /** One-line argument summary (redacted, bounded). */
  readonly args: string
  /** `allow` / `deny` / `escalate` at the gate, plus who settled an escalation. */
  readonly verdict: string
  readonly rule: string
  readonly decider?: string
}

export interface ApprovalContext {
  readonly taskId?: string
  readonly taskTitle?: string
  /** First part of the task prompt the orchestrator sent. */
  readonly taskPrompt?: string
  readonly sessionTitle?: string
  readonly route?: string
  /** The worker's latest assistant text before this call: its stated reason. */
  readonly lastAssistant?: string
  /** The `description` the worker gave this very call, if any. */
  readonly description?: string
  /** The task's previous gated calls, oldest first. */
  readonly recentCalls: readonly RecentCall[]
}

export const CONTEXT_LIMITS = { prompt: 400, assistant: 800, description: 300, args: 160, calls: 5 } as const

const clip = (text: string, max: number, keep: 'head' | 'tail' = 'head'): string => {
  const flat = redactSecrets(text).replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return keep === 'head' ? `${flat.slice(0, max)}…` : `…${flat.slice(-max)}`
}

/** One line for a tool call's arguments: the command or path when there is one, else compact JSON. */
export function oneLineArgs(args: Readonly<Record<string, unknown>>): string {
  const main = ['command', 'file_path', 'path', 'url', 'query'].map(k => args[k]).find(v => typeof v === 'string')
  return clip(typeof main === 'string' ? main : JSON.stringify(args) ?? '', CONTEXT_LIMITS.args)
}

export function buildApprovalContext(input: {
  task?: { id: string; title?: string; prompt: string; lastAssistant?: string }
  session?: { title?: string; route?: string }
  description?: unknown
  recentCalls: readonly RecentCall[]
}): ApprovalContext {
  const { task, session } = input
  return {
    ...task !== undefined ? { taskId: task.id } : {},
    ...task?.title !== undefined ? { taskTitle: clip(task.title, 120) } : {},
    ...task !== undefined ? { taskPrompt: clip(task.prompt, CONTEXT_LIMITS.prompt) } : {},
    ...session?.title !== undefined ? { sessionTitle: clip(session.title, 120) } : {},
    ...session?.route !== undefined ? { route: session.route } : {},
    ...task?.lastAssistant !== undefined && task.lastAssistant.trim() !== '' ? { lastAssistant: clip(task.lastAssistant, CONTEXT_LIMITS.assistant, 'tail') } : {},
    ...typeof input.description === 'string' && input.description.trim() !== '' ? { description: clip(input.description, CONTEXT_LIMITS.description) } : {},
    recentCalls: input.recentCalls.slice(-CONTEXT_LIMITS.calls),
  }
}
