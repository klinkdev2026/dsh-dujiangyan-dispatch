/**
 * Browser half: a "都江堰 / Dujiangyan" page in the desktop's left sidebar
 * (same mechanism as the official schedule page: a `sidebar.panellist` entry
 * addressing a `main` panel with the same id). Built by scripts/build-client.mjs
 * into lib/client.js; react / react-dom / cordis are provided by the host.
 */
import { ReviewPage } from './ReviewPage.tsx'
import { en, zh } from './locales.ts'

const NS = 'dujiangyan'
const PANEL_ID = 'dujiangyan'

/** Cordis services the page needs; the fiber waits for them. */
export const inject = ['slots', 'locale', 'layout']

function Icon({ size }: { size?: number }) {
  const s = size ?? 18
  // A stylized weir: a channel split by a fish-mouth levee.
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 5c3 0 4 3 9 3s6-3 9-3" />
      <path d="M12 8v4" />
      <path d="M12 12l-6 7M12 12l6 7" />
      <path d="M8 19h8" />
    </svg>
  )
}

export function apply(ctx: any): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dujiangyan: dictionaries')
  const t = ctx.locale.bind(NS)
  const openSession = (id: string): boolean => {
    const ws = ctx.get?.('uiWorkspace')
    if (ws?.openSession !== undefined) {
      ws.openSession(id)
      return true
    }
    const sessions = ctx.get?.('sessions')
    if (sessions?.open !== undefined) {
      sessions.open(id)
      ctx.layout?.selectPanel?.(null)
      return true
    }
    return false
  }
  // The desktop's own archive path keeps the sidebar in sync and is undoable (unarchive).
  const workspaces = () => ctx.get?.('uiWorkspace') ?? ctx.get?.('workspaces')
  const archiveSession = async (id: string): Promise<void> => {
    const ws = workspaces()
    if (ws?.archiveSession === undefined) throw new Error('archive is unavailable in this desktop version')
    await ws.archiveSession(id)
  }
  const unarchiveSession = async (id: string): Promise<void> => {
    const ws = workspaces()
    if (ws?.unarchiveSession === undefined) throw new Error('unarchive is unavailable in this desktop version')
    await ws.unarchiveSession(id)
  }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ openSession, archiveSession, unarchiveSession }),
  }, ReviewPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 40,
    locale: NS,
    label: () => t('panel'),
  }, Icon))
}
