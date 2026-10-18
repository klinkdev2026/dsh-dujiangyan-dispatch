/**
 * Routes for the desktop review panel (lib/client.js).
 *
 * They live on the Harness web server, which serves the desktop UI, and every
 * handler first asks the host's Connection to authenticate the request
 * (`requestRejection`: Host/Origin trust + an authenticated owner Peer — the
 * same fence official routes use). Raw web-server routes do not inherit that
 * fence on their own, so a missing Connection answers 503 instead of serving.
 * The browser never sees the MCP bearer token; it rides the desktop's cookie.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HostContext } from './host.ts'
import type { McpDeps } from './mcp.ts'
import { VERSION } from './mcp.ts'

export const ROUTE_PREFIX = '/plugins/dsh-dujiangyan-dispatch'
const MAX_BODY = 64 * 1024

interface WebServer {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }): () => void
}

interface RequestGate {
  requestRejection(req: IncomingMessage): number | undefined
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 })
    chunks.push(chunk as Buffer)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be an object')
    return value as Record<string, unknown>
  } catch (err) {
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { status: 400 })
  }
}

/** Everything the panel shows, in one snapshot (plus events after `cursor`). */
export function panelSnapshot(d: McpDeps, cursor: number): Record<string, unknown> {
  const tasks = d.tasks.list().slice(-300).reverse()
  const ev = d.events.since(cursor, 500)
  return {
    version: VERSION,
    now: new Date().toISOString(),
    workspaceRoots: d.config.workspaceRoots,
    limits: { maxSessions: d.config.maxSessions, maxActiveSessions: d.config.maxActiveSessions, approvalTimeoutMs: d.config.approvalTimeoutMs },
    sessions: d.registry.list().map(s => {
      const own = d.tasks.list({ sessionId: s.sessionId })
      const state = own.some(t => t.status === 'running') ? 'running'
        : own.some(t => t.status === 'queued' || t.status === 'waiting_resources' || t.status === 'waiting_slot') ? 'queued' : 'idle'
      return { ...s, state, taskCount: own.length, desktop: d.registry.desktopState(s.sessionId) }
    }),
    tasks: tasks.map(t => ({
      id: t.id, sessionId: t.sessionId, title: t.title, status: t.status, resources: t.resources, holds: t.holds,
      createdAt: t.createdAt, startedAt: t.startedAt, finishedAt: t.finishedAt, error: t.error,
      summary: t.result?.summary, errors: t.result?.errors, toolCalls: t.result?.toolCalls.length ?? 0,
      prompt: t.prompt.slice(0, 400),
    })),
    approvals: d.approvals.list(),
    leases: d.leases.list().map(l => ({ ...l, queued: d.leases.queued(l.name) })),
    providers: d.limiter.snapshot(),
    usage: d.usage.snapshot(),
    routeHealth: d.health.snapshot(),
    events: ev.events,
    cursor: ev.cursor,
    truncated: ev.truncated,
  }
}

export function installWebRoutes(ctx: HostContext, d: McpDeps): void {
  let registered = false
  const gate = () => ctx.get('connection') as RequestGate | undefined

  const guarded = (handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) =>
    async (req: IncomingMessage, res: ServerResponse) => {
      const g = gate()
      const rejection = g === undefined ? 503 : g.requestRejection(req)
      if (rejection !== undefined) return send(res, rejection, { error: rejection === 503 ? 'authentication unavailable' : rejection === 401 ? 'unauthorized' : 'forbidden' })
      try {
        await handler(req, res)
      } catch (err) {
        send(res, (err as { status?: number }).status ?? 500, { error: err instanceof Error ? err.message : String(err) })
      }
    }

  const register = () => {
    if (registered) return
    const server = (ctx.get('webServer') ?? ctx.get('httpServer')) as WebServer | undefined
    if (server === undefined) return
    registered = true

    ctx.effect(() => server.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/state`,
      handler: guarded(async (req, res) => {
        if (req.method !== 'GET') return send(res, 405, { error: 'GET only' })
        const cursor = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('cursor') ?? 0)
        send(res, 200, panelSnapshot(d, Number.isFinite(cursor) && cursor >= 0 ? cursor : 0))
      }),
    }), 'dujiangyan: panel state route')

    ctx.effect(() => server.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/approval`,
      handler: guarded(async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
        const body = await readJson(req)
        const id = typeof body['id'] === 'string' ? body['id'] : ''
        const decision = body['decision'] === 'allow' || body['decision'] === 'deny' ? body['decision'] : undefined
        const reason = typeof body['reason'] === 'string' && body['reason'].trim() !== '' ? body['reason'].trim().slice(0, 500) : undefined
        if (id === '' || decision === undefined) return send(res, 400, { error: 'id and decision (allow|deny) required' })
        const ok = d.approvals.decide(id, decision, reason ?? (decision === 'allow' ? 'approved in the desktop panel' : 'denied in the desktop panel'), 'human (desktop panel)')
        send(res, ok ? 200 : 409, ok ? { id, decision } : { error: 'already decided or unknown' })
      }),
    }), 'dujiangyan: panel approval route')

    ctx.effect(() => server.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/task-cancel`,
      handler: guarded(async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
        const body = await readJson(req)
        const taskId = typeof body['taskId'] === 'string' ? body['taskId'] : ''
        const ok = taskId !== '' && await d.tasks.cancel(taskId)
        send(res, ok ? 200 : 409, ok ? { cancelled: taskId } : { error: 'unknown or already finished' })
      }),
    }), 'dujiangyan: panel task-cancel route')
  }

  register()
  // Web servers can bind after this plugin; a profile without one stays MCP-only.
  ctx.on('internal/service', (name: string) => {
    if (name === 'webServer' || name === 'httpServer' || name === 'connection') register()
  })
}
