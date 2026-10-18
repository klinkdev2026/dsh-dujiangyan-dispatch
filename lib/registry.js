/**
 * Which sessions belong to the dispatch lineage.
 *
 * Root sessions are the ones this plugin created; they are persisted so the
 * gate keeps guarding them across a desktop restart. Any session whose
 * `header.parentSession` chain reaches a root (in-process subagents, agent-team
 * members) is in the lineage too and passes through the same gate. Sessions the
 * user opens by hand in the desktop UI are never touched.
 */
import path from 'node:path';
import { optional } from "./host.js";
import { readJson, writeJsonAtomic } from "./store.js";
const MAX_DEPTH = 8;
export class DispatchRegistry {
    roots = new Map();
    rootOfCache = new Map();
    file;
    ctx;
    constructor(ctx, stateDir) {
        this.ctx = ctx;
        this.file = path.join(stateDir, 'sessions.json');
        for (const rec of readJson(this.file, [])) {
            if (rec.closedAt === undefined)
                this.roots.set(rec.sessionId, rec);
            else
                this.closed.push(rec);
        }
    }
    closed = [];
    add(rec) {
        this.roots.set(rec.sessionId, rec);
        this.rootOfCache.clear();
        this.persist();
    }
    close(sessionId) {
        const rec = this.roots.get(sessionId);
        if (rec === undefined)
            return;
        rec.closedAt = new Date().toISOString();
        this.roots.delete(sessionId);
        this.closed.push(rec);
        this.rootOfCache.clear();
        this.persist();
    }
    get(sessionId) {
        return this.roots.get(sessionId);
    }
    list() {
        return [...this.roots.values()];
    }
    get size() {
        return this.roots.size;
    }
    /**
     * How the desktop currently sees a dispatched session: archived from the
     * sidebar (the user can do that at any time), present, or gone from every
     * workspace (then opening it would start an unrelated empty conversation).
     */
    desktopState(sessionId) {
        const ws = optional(this.ctx, 'workspaceRegistry');
        if (ws === undefined)
            return 'unknown';
        if (ws.archivedSessionIds?.includes(sessionId) === true)
            return 'archived';
        const views = ws.list?.();
        if (views === undefined)
            return 'unknown';
        return views.some(v => v.sessionIds?.includes(sessionId) === true) ? 'active' : 'missing';
    }
    /** The dispatch root a session descends from, or undefined when it is not in the lineage. */
    rootOf(agentOrSession) {
        if (agentOrSession === undefined)
            return undefined;
        const session = 'session' in agentOrSession ? agentOrSession.session : agentOrSession;
        const id = session.id ?? session.header.id;
        const cached = this.rootOfCache.get(id);
        if (cached !== undefined)
            return cached ?? undefined;
        let header = session.header;
        let found;
        for (let depth = 0; depth <= MAX_DEPTH; depth++) {
            const current = header.id ?? (depth === 0 ? id : undefined);
            if (current !== undefined && this.roots.has(current)) {
                found = current;
                break;
            }
            const parent = header.parentSession;
            if (parent === undefined)
                break;
            if (this.roots.has(parent)) {
                found = parent;
                break;
            }
            const next = this.headerOf(parent);
            if (next === undefined)
                break;
            header = next;
        }
        this.rootOfCache.set(id, found ?? null);
        return found;
    }
    headerOf(id) {
        const live = this.ctx.agents.get(id);
        if (live !== undefined)
            return live.session.header;
        return optional(this.ctx, 'sessions')?.get?.(id)?.header;
    }
    persist() {
        if (this.closed.length > 200)
            this.closed.splice(0, this.closed.length - 200);
        writeJsonAtomic(this.file, [...this.closed, ...this.roots.values()]);
    }
}
