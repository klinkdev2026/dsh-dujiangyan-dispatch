/**
 * The review page. It polls the plugin's authenticated state route (the
 * desktop's own session cookie rides along; no token in the browser), keeps
 * the event stream client-side by cursor, and posts approval decisions.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Key } from './locales.ts'

const BASE = '/plugins/dsh-dujiangyan-dispatch'
const MAX_EVENTS = 3000

type T = (key: Key) => string
type Props = { t: T; openSession: (id: string) => boolean; archiveSession: (id: string) => Promise<void>; unarchiveSession: (id: string) => Promise<void> }
type Tab = 'overview' | 'sessions' | 'gate' | 'approvals' | 'routes'

const css = {
  page: { padding: 'calc(20px + var(--dsh-frame-top-clearance, 0px)) 24px 24px', height: '100%', overflow: 'auto', boxSizing: 'border-box' as const, color: 'var(--dsw-alias-label-primary, inherit)', fontSize: 13 },
  h1: { fontSize: 18, fontWeight: 600, margin: '0 0 2px' },
  sub: { color: 'var(--dsw-alias-label-secondary, #888)', margin: '0 0 14px' },
  tabs: { display: 'flex', gap: 4, borderBottom: '1px solid var(--dsw-alias-border-l2, #8884)', marginBottom: 14, flexWrap: 'wrap' as const },
  tab: (on: boolean) => ({ padding: '6px 12px', border: 'none', background: 'none', cursor: 'pointer', color: 'inherit', fontSize: 13, borderBottom: on ? '2px solid var(--dsw-alias-state-business-primary, #3b82f6)' : '2px solid transparent', fontWeight: on ? 600 : 400 }),
  card: { border: '1px solid var(--dsw-alias-border-l2, #8884)', borderRadius: 8, padding: 12, marginBottom: 12, background: 'var(--dsw-alias-bg-layer-1, transparent)' },
  row: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' as const },
  stat: { minWidth: 120 },
  statN: { fontSize: 22, fontWeight: 600 },
  muted: { color: 'var(--dsw-alias-label-secondary, #888)' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 },
  th: { textAlign: 'left' as const, padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2, #8884)', color: 'var(--dsw-alias-label-secondary, #888)', fontWeight: 500 },
  td: { padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1, #8882)', verticalAlign: 'top' as const, wordBreak: 'break-word' as const },
  btn: { padding: '4px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, #8886)', background: 'none', color: 'inherit', cursor: 'pointer', fontSize: 12 },
  btnAllow: { borderColor: 'var(--dsw-alias-state-success-primary, #16a34a)', color: 'var(--dsw-alias-state-success-primary, #16a34a)' },
  btnDeny: { borderColor: 'var(--dsw-alias-state-error-primary, #dc2626)', color: 'var(--dsw-alias-state-error-primary, #dc2626)' },
  pill: (color: string) => ({ display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: 11, border: `1px solid ${color}`, color }),
  code: { fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)', fontSize: 11, whiteSpace: 'pre-wrap' as const, wordBreak: 'break-all' as const },
  input: { flex: 1, minWidth: 200, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, #8886)', background: 'transparent', color: 'inherit', fontSize: 12 },
}

const C = {
  ok: 'var(--dsw-alias-state-success-primary, #16a34a)',
  warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
  err: 'var(--dsw-alias-state-error-primary, #dc2626)',
  info: 'var(--dsw-alias-state-business-primary, #3b82f6)',
  mute: 'var(--dsw-alias-label-secondary, #888)',
}

const statusColor = (s: string) => s === 'done' ? C.ok : s === 'error' || s === 'interrupted' || s === 'needs_attention' ? C.err : s === 'cancelled' ? C.mute : s === 'running' ? C.info : C.warn
const kindColor = (k: string) => k === 'deny' ? C.err : k === 'escalate' ? C.warn : C.ok
const time = (iso?: string) => iso === undefined ? '' : new Date(iso).toLocaleTimeString()
const short = (id?: string) => (id ?? '').replace(/^session-/, '').slice(0, 8)

function useDujiangyan() {
  const [state, setState] = useState<any>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const events = useRef<any[]>([])
  const cursor = useRef(0)
  const inflight = useRef(false)
  const [, bump] = useState(0)

  const poll = useCallback(async () => {
    if (inflight.current) return
    inflight.current = true
    try {
      const res = await fetch(`${BASE}/state?cursor=${cursor.current}`, { cache: 'no-store', credentials: 'same-origin' })
      if (!res.ok) throw new Error(`${res.status}`)
      const snap = await res.json()
      if (snap.truncated) events.current = []
      if (snap.events.length > 0) {
        events.current = [...events.current, ...snap.events].slice(-MAX_EVENTS)
      }
      cursor.current = snap.cursor
      setState(snap)
      setError(undefined)
      bump(n => n + 1)
    } catch (err) {
      setError(String(err))
    } finally {
      inflight.current = false
    }
  }, [])

  useEffect(() => {
    void poll()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void poll()
    }, 2000)
    return () => clearInterval(timer)
  }, [poll])

  const post = useCallback(async (path: string, body: unknown) => {
    const res = await fetch(`${BASE}/${path}`, { method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const json = await res.json().catch(() => ({}))
    void poll()
    return { ok: res.ok, json }
  }, [poll])

  return { state, error, events: events.current, post }
}

export function ReviewPage({ t, openSession, archiveSession, unarchiveSession }: Props) {
  const { state, error, events, post } = useDujiangyan()
  const [tab, setTab] = useState<Tab>('overview')
  if (state === undefined) {
    return <div style={css.page}>{error !== undefined ? `${t('loadError')}: ${error}` : t('loading')}</div>
  }
  const pending = state.approvals.length
  const tabs: Array<[Tab, string]> = [
    ['overview', t('tabOverview')],
    ['sessions', t('tabSessions')],
    ['gate', t('tabGate')],
    ['approvals', `${t('tabApprovals')}${pending > 0 ? ` (${pending})` : ''}`],
    ['routes', t('tabRoutes')],
  ]
  return (
    <div style={css.page}>
      <h1 style={css.h1}>{t('title')}</h1>
      <p style={css.sub}>{t('subtitle')} · v{state.version}{error !== undefined ? ` · ⚠ ${error}` : ''}</p>
      <div style={css.tabs} role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} style={css.tab(tab === id)} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      <HealthBanner t={t} health={state.health} onOpen={() => setTab('approvals')} />
      {tab === 'overview' && <Overview t={t} state={state} events={events} />}
      {tab === 'sessions' && <Sessions t={t} state={state} openSession={openSession} archiveSession={archiveSession} unarchiveSession={unarchiveSession} post={post} />}
      {tab === 'gate' && <Gate t={t} state={state} events={events} />}
      {tab === 'approvals' && <Approvals t={t} state={state} post={post} openSession={openSession} />}
      {tab === 'routes' && <Routes t={t} state={state} events={events} />}
    </div>
  )
}

function Overview({ t, state, events }: { t: T; state: any; events: any[] }) {
  const running = state.tasks.filter((x: any) => x.status === 'running').length
  const queuedTasks = state.tasks.filter((x: any) => x.status === 'queued' || String(x.status).startsWith('waiting')).length
  const byState = { running: 0, queued: 0, idle: 0 } as Record<string, number>
  const byCreator = new Map<string, number>()
  for (const s of state.sessions) {
    byState[s.state] = (byState[s.state] ?? 0) + 1
    byCreator.set(s.createdBy ?? '?', (byCreator.get(s.createdBy ?? '?') ?? 0) + 1)
  }
  const recent = events.filter(e => e.type === 'gate/decision' || e.type.startsWith('approval/') || e.type.startsWith('route/') || e.type === 'routes/probed' || e.type.startsWith('task/') && e.type !== 'task/tool-call').slice(-15).reverse()
  return (
    <>
      <div style={{ ...css.card, ...css.row }}>
        <div style={css.stat}>
          <div style={css.statN}>{state.sessions.length}</div>
          <div style={css.muted}>{t('dispatchedSessions')}</div>
          <div style={css.muted}>{t('stRunning')} {byState.running} · {t('stQueued')} {byState.queued} · {t('stIdle')} {byState.idle}</div>
          <div style={css.muted}>{[...byCreator].map(([k, v]) => `${k} ${v}`).join(' · ')}</div>
        </div>
        <div style={css.stat}><div style={css.statN}>{running}</div><div style={css.muted}>{t('activeTasks')}</div><div style={css.muted}>{t('stQueued')} {queuedTasks}</div></div>
        <div style={css.stat}><div style={{ ...css.statN, color: state.approvals.length > 0 ? C.warn : undefined }}>{state.approvals.length}</div><div style={css.muted}>{t('pending')}</div></div>
        <div style={css.stat}><div style={css.statN}>{state.leases.length}</div><div style={css.muted}>{t('leases')}</div></div>
      </div>
      <ProvidersTable t={t} providers={state.providers} />
      <div style={css.card}>
        <table style={css.table}><tbody>
          {recent.length === 0 && <tr><td style={css.td}>{t('noEvents')}</td></tr>}
          {recent.map(e => (
            <tr key={e.seq}>
              <td style={{ ...css.td, width: 80 }}>{time(e.at)}</td>
              <td style={{ ...css.td, width: 140 }}>{e.type}</td>
              <td style={css.td}>{describe(e)}</td>
            </tr>
          ))}
        </tbody></table>
      </div>
    </>
  )
}

function describe(e: any): string {
  const d = e.data ?? {}
  switch (e.type) {
    case 'gate/decision': return `${d.tool} · ${d.kind} · ${d.rule}${d.reason ? ` — ${d.reason}` : ''}`
    case 'approval/pending': return `${d.tool} · ${d.rule} — ${d.reason}`
    case 'approval/settled': return `${d.tool} → ${d.result}`
    case 'route/switch': return `${d.from} → ${d.to} (${d.reason})`
    case 'route/broken': return `${d.route} — ${d.reason}`
    case 'routes/probed': return `${d.ok}/${d.count} ok${d.failed?.length ? ` · failed: ${d.failed.map((f: any) => f.route).join(', ')}` : ''} · by ${d.by}`
    case 'limits/override': return JSON.stringify(d)
    default: return [d.title, d.taskId, d.error, d.summary?.changes].filter(Boolean).join(' · ')
  }
}

function ProvidersTable({ t, providers }: { t: T; providers: Record<string, any> }) {
  const names = Object.keys(providers)
  if (names.length === 0) return null
  return (
    <div style={css.card}>
      <table style={css.table}>
        <thead><tr>{[t('provider'), t('cap'), t('inFlight'), t('queued'), t('circuit'), t('counts')].map(h => <th key={h} style={css.th}>{h}</th>)}</tr></thead>
        <tbody>{names.map(n => {
          const p = providers[n]
          return (
            <tr key={n}>
              <td style={css.td}>{n}</td>
              <td style={css.td}>{p.cap} / {p.maxConcurrent}</td>
              <td style={css.td}>{p.inFlight}</td>
              <td style={css.td}>{p.queued}</td>
              <td style={css.td}><span style={css.pill(p.circuit === 'closed' ? C.ok : p.circuit === 'open' ? C.err : C.warn)}>{p.circuit}</span></td>
              <td style={css.td}>{p.counts.ok} / {p.counts.rate_limited} / {p.counts.overloaded} / {p.counts.error}</td>
            </tr>
          )
        })}</tbody>
      </table>
    </div>
  )
}

type Batch = { key: string; label: string; createdBy: string; sessions: any[]; first: string }

/** Group sessions by dispatch batch (one orchestrator run, or a caller-named batch). */
function batchesOf(sessions: any[], legacy: string): Batch[] {
  const m = new Map<string, Batch>()
  for (const s of sessions) {
    const key = s.batch ?? `legacy:${s.createdBy ?? '?'}`
    const b = m.get(key) ?? { key, label: s.batch ?? `${legacy}${s.createdBy ? ` · ${s.createdBy}` : ''}`, createdBy: s.createdBy ?? '?', sessions: [], first: s.createdAt }
    b.sessions.push(s)
    if (String(s.createdAt) < String(b.first)) b.first = s.createdAt
    m.set(key, b)
  }
  return [...m.values()].sort((a, b) => String(b.first).localeCompare(String(a.first)))
}

/** Confirmation dialog listing exactly what will be archived; nothing happens until confirmed. */
function ArchiveDialog({ t, title, sessions, preselect, onCancel, onConfirm }: {
  t: T; title: string; sessions: any[]; preselect: boolean
  onCancel: () => void; onConfirm: (ids: string[]) => Promise<void>
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(sessions.map(s => [s.sessionId, preselect && s.state === 'idle'])))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const ids = sessions.filter(s => checked[s.sessionId] === true).map(s => s.sessionId)
  return (
    <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ ...css.card, width: 'min(640px, 92vw)', maxHeight: '80vh', overflow: 'auto', background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1, #222))' }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 6 }}>{title}</div>
        <div style={{ ...css.muted, marginBottom: 10 }}>{t('archiveWarn')}</div>
        {sessions.map(s => {
          const busySession = s.state !== 'idle'
          return (
            <label key={s.sessionId} style={{ ...css.row, padding: '4px 0', opacity: busySession ? 0.55 : 1 }}>
              <input type="checkbox" disabled={busySession} checked={checked[s.sessionId] === true} onChange={e => setChecked({ ...checked, [s.sessionId]: e.target.checked })} />
              <span>{s.title ?? short(s.sessionId)}</span>
              {s.batch !== undefined && <span style={css.muted}>{s.batch}</span>}
              {busySession && <span style={css.pill(C.warn)}>{t('busyCannotArchive')}</span>}
            </label>
          )
        })}
        {error !== undefined && <div style={{ color: C.err, marginTop: 8 }}>{error}</div>}
        <div style={{ ...css.row, justifyContent: 'flex-end', marginTop: 12 }}>
          <span style={css.muted}>{t('selected')} {ids.length}</span>
          <button type="button" style={css.btn} onClick={onCancel} disabled={busy}>{t('cancelBtn')}</button>
          <button type="button" style={{ ...css.btn, ...css.btnDeny }} disabled={busy || ids.length === 0} onClick={async () => {
            setBusy(true)
            try {
              await onConfirm(ids)
            } catch (err) {
              setError(String(err))
              setBusy(false)
            }
          }}>{t('confirmArchive')} ({ids.length})</button>
        </div>
      </div>
    </div>
  )
}

function Sessions({ t, state, openSession, archiveSession, unarchiveSession, post }: {
  t: T; state: any; openSession: (id: string) => boolean
  archiveSession: (id: string) => Promise<void>; unarchiveSession: (id: string) => Promise<void>
  post: (p: string, b: unknown) => Promise<unknown>
}) {
  const [showArchived, setShowArchived] = useState(false)
  const [dialog, setDialog] = useState<{ title: string; sessions: any[]; preselect: boolean } | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const bySession = useMemo(() => {
    const m = new Map<string, any[]>()
    for (const task of state.tasks) m.set(task.sessionId, [...(m.get(task.sessionId) ?? []), task])
    return m
  }, [state.tasks])
  const archivedCount = state.sessions.filter((s: any) => s.desktop === 'archived').length
  const visible = state.sessions.filter((s: any) => showArchived || s.desktop !== 'archived')
  const batches = batchesOf(visible, t('legacyBatch'))
  const activeAll = state.sessions.filter((s: any) => s.desktop !== 'archived' && s.desktop !== 'missing')
  const runArchive = async (ids: string[]) => {
    for (const id of ids) await archiveSession(id)
    setDialog(undefined)
    setNotice(`${t('archivedN')} ${ids.length}`)
  }
  if (state.sessions.length === 0) return <div style={css.card}>{t('noSessions')}</div>
  return (
    <>
      <div style={{ ...css.row, justifyContent: 'space-between', marginBottom: 10 }}>
        <label style={css.row}>
          <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
          <span>{t('showArchived')} ({archivedCount})</span>
        </label>
        <div style={css.row}>
          {notice !== undefined && <span style={css.muted}>{notice}</span>}
          {/* Separate from per-batch archiving, and nothing is preselected: archiving everything must be a deliberate choice. */}
          <button type="button" style={{ ...css.btn, ...css.btnDeny }} disabled={activeAll.length === 0}
            onClick={() => setDialog({ title: t('archiveAllTitle'), sessions: activeAll, preselect: false })}>{t('archiveAll')}</button>
        </div>
      </div>
      {batches.map(b => {
        const live = b.sessions.filter(s => s.desktop !== 'archived' && s.desktop !== 'missing')
        const archived = b.sessions.filter(s => s.desktop === 'archived')
        const counts = { running: 0, queued: 0, idle: 0 } as Record<string, number>
        for (const s of live) counts[s.state] = (counts[s.state] ?? 0) + 1
        return (
          <div key={b.key} style={{ ...css.card, padding: 0 }}>
            <div style={{ ...css.row, justifyContent: 'space-between', padding: '10px 12px', borderBottom: '1px solid var(--dsw-alias-border-l2, #8884)' }}>
              <div>
                <div style={{ fontWeight: 600 }}>{t('batch')}: {b.label}</div>
                <div style={css.muted}>{t('createdBy')} {b.createdBy} · {time(b.first)} · {b.sessions.length} · {t('stRunning')} {counts.running} · {t('stQueued')} {counts.queued} · {t('stIdle')} {counts.idle}{archived.length > 0 ? ` · ${t('stArchived')} ${archived.length}` : ''}</div>
              </div>
              <div style={css.row}>
                {archived.length > 0 && (
                  <button type="button" style={css.btn} onClick={async () => {
                    for (const s of archived) await unarchiveSession(s.sessionId)
                    setNotice(`${t('restoredN')} ${archived.length}`)
                  }}>{t('restoreBatch')}</button>
                )}
                <button type="button" style={{ ...css.btn, ...css.btnDeny }} disabled={live.length === 0}
                  onClick={() => setDialog({ title: `${t('archiveBatchTitle')}: ${b.label}`, sessions: live, preselect: true })}>{t('archiveBatch')}</button>
              </div>
            </div>
            {b.sessions.map((s: any) => (
              <div key={s.sessionId} style={{ padding: '10px 12px', borderBottom: '1px solid var(--dsw-alias-border-l1, #8882)', opacity: s.desktop === 'archived' ? 0.6 : 1 }}>
                <div style={{ ...css.row, justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>
                      {s.desktop === 'archived' ? <span style={css.pill(C.mute)}>{t('stArchived')}</span>
                        : s.desktop === 'missing' ? <span style={css.pill(C.err)}>{t('stMissing')}</span>
                          : <span style={css.pill(s.state === 'running' ? C.info : s.state === 'queued' ? C.warn : C.mute)}>{s.state === 'running' ? t('stRunning') : s.state === 'queued' ? t('stQueued') : t('stIdle')}</span>}{' '}
                      {s.title ?? short(s.sessionId)}
                    </div>
                    <div style={css.muted}>{t('workspace')}: {s.cwd} · {t('route')}: {s.chain.map((r: any) => `${r.provider}/${r.model}`).join(' → ')} · {short(s.sessionId)} · {time(s.createdAt)}</div>
                    {(() => {
                      const live = (bySession.get(s.sessionId) ?? []).find((x: any) => x.status === 'running' && typeof x.latest === 'string' && x.latest !== '')
                      return live === undefined ? null : <div style={{ marginTop: 4 }}><span style={css.pill(C.info)}>{t('narration')}</span> {live.latest}</div>
                    })()}
                  </div>
                  <div style={css.row}>
                    {/* Opening an archived or vanished session would start an unrelated empty conversation. */}
                    {s.desktop === 'archived' && <button type="button" style={css.btn} onClick={() => void unarchiveSession(s.sessionId)}>{t('restore')}</button>}
                    {s.desktop !== 'archived' && s.desktop !== 'missing' && <button type="button" style={css.btn} onClick={() => openOrCopy(openSession, s.sessionId, () => setNotice(t('ctxOpenFailed')))}>{t('open')}</button>}
                  </div>
                </div>
                {(bySession.get(s.sessionId) ?? []).slice(0, 8).map((task: any) => (
                  <div key={task.id} style={{ marginTop: 6 }}>
                    <div style={css.row}>
                      <span style={css.pill(statusColor(task.status))}>{task.status}</span>
                      <span>{task.title ?? task.prompt.slice(0, 80)}</span>
                      {task.resources.length > 0 && <span style={css.muted}>[{task.resources.join(', ')}]</span>}
                      <span style={css.muted}>{time(task.startedAt ?? task.createdAt)}</span>
                      {(task.status === 'running' || task.status === 'queued' || task.status.startsWith('waiting')) && (
                        <button type="button" style={css.btn} onClick={() => void post('task-cancel', { taskId: task.id })}>{t('cancel')}</button>
                      )}
                    </div>
                    {task.summary !== undefined && (task.summary.changes || task.summary.leftovers) && (
                      <div style={{ ...css.muted, marginTop: 4 }}>{task.summary.changes}{task.summary.leftovers ? ` · ⚑ ${task.summary.leftovers}` : ''}</div>
                    )}
                    {(task.error || (task.errors ?? []).length > 0) && <div style={{ color: C.err, marginTop: 4 }}>{task.error ?? task.errors.join('; ')}</div>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )
      })}
      {dialog !== undefined && (
        <ArchiveDialog t={t} title={dialog.title} sessions={dialog.sessions} preselect={dialog.preselect}
          onCancel={() => setDialog(undefined)} onConfirm={runArchive} />
      )}
    </>
  )
}

function Gate({ t, state, events }: { t: T; state: any; events: any[] }) {
  const [filter, setFilter] = useState<'all' | 'deny' | 'escalate'>('all')
  const titles = useMemo(() => new Map(state.sessions.map((s: any) => [s.sessionId, s.title])), [state.sessions])
  const rows = events.filter(e => e.type === 'gate/decision' && (filter === 'all' || e.data.kind === filter)).slice(-300).reverse()
  return (
    <div style={css.card}>
      <div style={{ ...css.row, marginBottom: 8 }}>
        {(['all', 'deny', 'escalate'] as const).map(f => (
          <button key={f} type="button" style={{ ...css.btn, fontWeight: filter === f ? 600 : 400 }} onClick={() => setFilter(f)}>
            {f === 'all' ? t('filterAll') : f === 'deny' ? t('filterDeny') : t('filterEscalate')}
          </button>
        ))}
      </div>
      <table style={css.table}>
        <thead><tr>{[t('time'), t('sessions'), t('tool'), t('decision'), t('rule'), t('reason')].map(h => <th key={h} style={css.th}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td style={css.td} colSpan={6}>{t('noEvents')}</td></tr>}
          {rows.map(e => (
            <tr key={e.seq}>
              <td style={css.td}>{time(e.at)}</td>
              <td style={css.td}>{String(titles.get(e.data.root) ?? short(e.data.sessionId))}</td>
              <td style={css.td}>{e.data.tool}</td>
              <td style={css.td}><span style={css.pill(kindColor(e.data.kind))}>{e.data.kind}</span></td>
              <td style={css.td}>{e.data.rule}</td>
              <td style={css.td}>{e.data.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Open a worker session's transcript; when this desktop cannot navigate, copy the id instead. */
function openOrCopy(openSession: (id: string) => boolean, id: string, onFallback: () => void): void {
  if (openSession(id)) return
  void navigator.clipboard?.writeText(id).catch(() => undefined)
  onFallback()
}

/** Everything the gate attached about the call's task and the worker's own explanation. */
function ApprovalContextView({ t, ctx }: { t: T; ctx: any }) {
  if (ctx === undefined) return null
  const calls: any[] = ctx.recentCalls ?? []
  return (
    <details open style={{ ...css.card, marginBottom: 6 }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{t('ctxTitle')}</summary>
      {ctx.taskTitle !== undefined && <div style={css.muted}>{t('ctxTask')}: {ctx.taskTitle}{ctx.route !== undefined ? ` · ${ctx.route}` : ''}</div>}
      <div style={{ margin: '6px 0' }}><b>{t('ctxWhy')}:</b> {ctx.lastAssistant ?? <span style={css.muted}>{t('ctxNone')}</span>}</div>
      {ctx.description !== undefined && <div style={{ marginBottom: 6 }}><b>{t('ctxDesc')}:</b> {ctx.description}</div>}
      {calls.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <b>{t('ctxRecent')}:</b>
          {calls.map((c, i) => (
            <div key={i} style={{ ...css.code, fontSize: 12 }}>
              <span style={css.pill(c.verdict.startsWith('deny') || c.verdict.endsWith('deny') ? C.err : c.verdict === 'allow' || c.verdict.endsWith('allow') ? C.ok : C.warn)}>{c.verdict}</span> {c.tool} {c.args}{c.decider !== undefined ? ` (${c.decider})` : ''}
            </div>
          ))}
        </div>
      )}
      {ctx.taskPrompt !== undefined && (
        <details><summary style={{ cursor: 'pointer' }}>{t('ctxPrompt')}</summary><div style={{ ...css.code, whiteSpace: 'pre-wrap' }}>{ctx.taskPrompt}</div></details>
      )}
    </details>
  )
}

/** Alerts from the watchdog (approval aging, AI judge failures, stalled tasks, absent orchestrator). */
function HealthBanner({ t, health, onOpen }: { t: T; health: any; onOpen: () => void }) {
  const alerts: any[] = health?.alerts ?? []
  if (alerts.length === 0) return null
  const critical = alerts.some(a => a.level === 'critical')
  return (
    <div role="alert" style={{ ...css.card, borderColor: critical ? C.err : C.warn, borderWidth: 2, borderStyle: 'solid' }}>
      <b style={{ color: critical ? C.err : C.warn }}>{t('healthTitle')} ({alerts.length})</b>
      {alerts.map(a => (
        <div key={a.id} style={css.muted}>
          <span style={css.pill(a.level === 'critical' ? C.err : C.warn)}>{a.kind}</span> {a.message}
          {a.kind === 'approval-aging' && <> <button type="button" style={css.btn} onClick={onOpen}>{t('tabApprovals')}</button></>}
        </div>
      ))}
    </div>
  )
}

const ageMinutes = (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / 60_000)

function Approvals({ t, state, post, openSession }: { t: T; state: any; post: (p: string, b: unknown) => Promise<{ ok: boolean; json: any }>; openSession: (id: string) => boolean }) {
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const titles = useMemo(() => new Map(state.sessions.map((s: any) => [s.sessionId, s.title])), [state.sessions])
  const aiBadge = state.aiApproval !== undefined && (
    <div style={{ ...css.card, ...css.muted }}>
      <span style={css.pill(state.aiApproval.enabled ? C.ok : C.warn)}>{t(state.aiApproval.enabled ? 'aiOn' : 'aiOff')}</span>{' '}
      {state.aiApproval.enabled ? (state.aiApproval.judges ?? []).map((j: any) => j.model).join(' + ') : ''}
    </div>
  )
  if (state.approvals.length === 0) return <>{aiBadge}<div style={css.card}>{t('noPending')}</div></>
  const decide = async (id: string, decision: 'allow' | 'deny') => {
    setBusy(id)
    try {
      await post('approval', { id, decision, reason: reasons[id] })
    } finally {
      setBusy(undefined)
    }
  }
  return (
    <>
      {aiBadge}
      {state.approvals.map((a: any) => (
        <div key={a.id} style={css.card}>
          <div style={{ ...css.row, justifyContent: 'space-between' }}>
            <div>
              <span style={css.pill(C.warn)}>{a.rule}</span> <b>{a.tool}</b>
              <span style={css.muted}> · {String(titles.get(a.sessionId) ?? short(a.sessionId))} · {t('expiresAt')} {time(a.expiresAt)}</span>
              {' '}<span style={css.pill(ageMinutes(a.createdAt) >= 3 ? C.err : C.mute)}>{t('waited')} {ageMinutes(a.createdAt)} {t('minutes')}</span>
            </div>
            <button type="button" style={css.btn} onClick={() => openOrCopy(openSession, a.sessionId, () => setNotice(t('ctxOpenFailed')))}>{t('open')}</button>
          </div>
          {notice !== undefined && <div style={css.muted}>{notice}</div>}
          {a.danger !== undefined && <div role="alert" style={{ ...css.pill(C.err), margin: '6px 0' }}>{t('dangerSandbox')}</div>}
          <div style={{ margin: '6px 0' }}>{a.reason}</div>
          {a.truncated === true && <div style={{ ...css.pill(C.warn), marginBottom: 6 }}>{t('truncated')}</div>}
          <ApprovalContextView t={t} ctx={a.context} />
          {a.ai !== undefined && (
            <div style={{ ...css.card, marginBottom: 6 }}>
              <b>{t(a.ai.status === 'judging' ? 'aiJudging' : 'aiSplit')}</b>
              {(a.ai.opinions ?? []).map((o: any) => (
                <div key={o.judge} style={css.muted}><span style={css.pill(o.decision === 'allow' ? C.ok : o.decision === 'deny' ? C.err : C.warn)}>{o.decision}</span> {o.judge}: {o.reason}</div>
              ))}
            </div>
          )}
          <div style={{ ...css.code, ...css.card, marginBottom: 8, maxHeight: 360, overflow: 'auto' }}>{a.summary}</div>
          <div style={css.row}>
            <input style={css.input} placeholder={t('reasonPlaceholder')} value={reasons[a.id] ?? ''} onChange={e => setReasons({ ...reasons, [a.id]: e.target.value })} />
            <button type="button" disabled={busy === a.id} style={{ ...css.btn, ...css.btnAllow }} onClick={() => void decide(a.id, 'allow')}>{t('allow')}</button>
            <button type="button" disabled={busy === a.id} style={{ ...css.btn, ...css.btnDeny }} onClick={() => void decide(a.id, 'deny')}>{t('deny')}</button>
          </div>
        </div>
      ))}
    </>
  )
}

function Routes({ t, state, events }: { t: T; state: any; events: any[] }) {
  const broken = Object.entries(state.routeHealth?.broken ?? {})
  const probes = events.filter(e => e.type === 'routes/probed').slice(-50).reverse()
  const routeEvents = events.filter(e => e.type === 'route/switch' || e.type === 'route/broken' || e.type === 'limits/override').slice(-100).reverse()
  const usage = Object.entries(state.usage ?? {})
  return (
    <>
      <ProvidersTable t={t} providers={state.providers} />
      <div style={css.card}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('broken')}</div>
        {broken.length === 0 ? <div style={css.muted}>{t('noEvents')}</div> : (
          <table style={css.table}><tbody>{broken.map(([route, b]: [string, any]) => (
            <tr key={route}><td style={css.td}>{route}</td><td style={css.td}>{b.reason}</td><td style={css.td}>{t('until')} {time(b.until)}</td></tr>
          ))}</tbody></table>
        )}
      </div>
      <div style={css.card}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('probes')}</div>
        {probes.length === 0 ? <div style={css.muted}>{t('noEvents')}</div> : probes.map(p => (
          <div key={p.seq} style={{ marginBottom: 8 }}>
            <div>{time(p.at)} · {p.data.ok}/{p.data.count} ok · by {p.data.by}</div>
            {(p.data.failed ?? []).map((f: any) => <div key={f.route} style={{ ...css.code, color: C.err }}>{f.route} — {f.detail}</div>)}
          </div>
        ))}
      </div>
      <div style={css.card}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('routeEvents')}</div>
        {routeEvents.length === 0 ? <div style={css.muted}>{t('noEvents')}</div> : (
          <table style={css.table}><tbody>{routeEvents.map(e => (
            <tr key={e.seq}><td style={{ ...css.td, width: 80 }}>{time(e.at)}</td><td style={{ ...css.td, width: 120 }}>{e.type}</td><td style={css.td}>{describe(e)}</td></tr>
          ))}</tbody></table>
        )}
      </div>
      <div style={css.card}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('usage')}</div>
        <table style={css.table}>
          <thead><tr>{[t('route'), t('requests'), t('tokensIn'), t('tokensOut'), t('cacheHit')].map(h => <th key={h} style={css.th}>{h}</th>)}</tr></thead>
          <tbody>{usage.map(([route, u]: [string, any]) => (
            <tr key={route}>
              <td style={css.td}>{route}</td><td style={css.td}>{u.requests}</td><td style={css.td}>{u.inputTokens}</td><td style={css.td}>{u.outputTokens}</td>
              <td style={css.td}>{u.cacheHitRate === null ? '—' : `${Math.round(u.cacheHitRate * 100)}%`}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </>
  )
}
