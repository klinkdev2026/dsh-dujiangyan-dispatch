/**
 * Durable state helpers: atomic JSON replacement and JSON Lines journals.
 *
 * Replacement writes a sibling temp file and renames it over the target. On
 * Windows a rename onto a file another process holds open fails with EPERM /
 * EACCES / EBUSY, so it is retried briefly before falling back to a direct
 * write (the same trade-off dsh-agent-teams makes).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
export function ensureDir(dir) {
    mkdirSync(dir, { recursive: true });
    return dir;
}
export function writeJsonAtomic(file, value) {
    ensureDir(path.dirname(file));
    const body = `${JSON.stringify(value, null, 2)}\n`;
    const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(tmp, body);
    for (let attempt = 0;; attempt++) {
        try {
            renameSync(tmp, file);
            return;
        }
        catch (err) {
            const code = err.code ?? '';
            if (!TRANSIENT.has(code)) {
                rmSync(tmp, { force: true });
                throw err;
            }
            if (attempt >= 5) {
                writeFileSync(file, body);
                rmSync(tmp, { force: true });
                return;
            }
            sleepSync(10 * (attempt + 1));
        }
    }
}
export function readJson(file, fallback) {
    if (!existsSync(file))
        return fallback;
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        return fallback;
    }
}
export function appendJsonl(file, value) {
    ensureDir(path.dirname(file));
    appendFileSync(file, `${JSON.stringify(value)}\n`);
}
/** Read a JSON Lines file, skipping a torn last line. */
export function readJsonl(file) {
    if (!existsSync(file))
        return [];
    const out = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line.trim() === '')
            continue;
        try {
            out.push(JSON.parse(line));
        }
        catch {
            // A crash mid-append leaves at most one partial line.
        }
    }
    return out;
}
