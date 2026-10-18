/**
 * Local endpoint discovery and authentication.
 *
 * The bearer token lives in `<stateDir>/token` (0600 on POSIX; on Windows the
 * state dir sits under the user profile, which other standard users cannot
 * read). `endpoint.json` publishes the URL for clients and carries no secret.
 *
 * Every request must (1) come from loopback, (2) name a loopback Host
 * (DNS-rebinding guard), (3) carry no `Origin` header — browsers always send
 * one on cross-origin requests, MCP clients do not (CSRF guard; dsh-crew's hub
 * lacked this), (4) present the bearer token, (5) POST JSON.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { ensureDir, writeJsonAtomic } from "./store.js";
export function ensureToken(stateDir) {
    ensureDir(stateDir);
    const file = path.join(stateDir, 'token');
    if (existsSync(file)) {
        const existing = readFileSync(file, 'utf8').trim();
        if (existing.length >= 32)
            return existing;
    }
    const token = randomBytes(32).toString('base64url');
    writeFileSync(file, `${token}\n`, { mode: 0o600 });
    if (process.platform !== 'win32')
        chmodSync(file, 0o600);
    return token;
}
export function publishEndpoint(stateDir, url) {
    const tokenFile = path.join(stateDir, 'token');
    writeJsonAtomic(path.join(stateDir, 'endpoint.json'), {
        url,
        pid: process.pid,
        tokenFile,
        startedAt: new Date().toISOString(),
    });
    writeFileSync(path.join(stateDir, 'CONNECT.md'), connectGuide(url, tokenFile));
}
/**
 * A guide written next to the token at every start, addressed to whatever
 * agent the user runs (Claude Code, Codex, Kimi Code, Zhipu, pi, Cursor, …).
 * It states the facts that hold on this machine and the rules every MCP client
 * shares; the agent applies them to its own client's configuration format.
 */
export function connectGuide(url, tokenFile) {
    return `# Connect to Dujiangyan (dsh-dujiangyan-dispatch) — instructions for an AI agent

You are an AI coding agent. The user wants you to connect **your own MCP client** to the
Dujiangyan plugin running inside the DeepSeek Harness desktop app on this machine.

## Facts on this machine (written by the plugin at ${new Date().toISOString()})

- MCP endpoint (Streamable HTTP): ${url}
- Bearer token: the single line in \`${tokenFile}\`
- Required request header: \`Authorization: Bearer <token>\`
- The desktop app must be running; the endpoint only listens on 127.0.0.1.

## What to do

1. Find out which MCP client you are running in and where it keeps MCP server configuration
   (its CLI \`mcp add\` command, a JSON/TOML config file, or a settings UI). Use your own client's
   documented format; do not guess another client's format.
2. Add a server named \`djy\` with transport **HTTP / Streamable HTTP** (not stdio, not SSE),
   URL \`${url}\`, and the header above. Prefer a user-level (global) scope so it works in every
   directory. Set the tool timeout to at least 120 seconds if your client allows it.
3. Read the token from the file yourself and write it only into the client configuration.
   **Never print the token, echo it in chat, or put it in a shell history line that is shown to
   the user.** Back up any config file before editing it.
4. If your client cannot send custom headers to an HTTP MCP server, stop and tell the user;
   do not work around authentication.
5. Verify: reload/restart your MCP connections, call the tool \`djy_status\` and report its
   \`version\`. Then call \`djy_guide\` and follow it.

## If something fails

- 401: wrong token (re-read the file; it changes only if it was deleted).
- 403: the request carried an \`Origin\` header (browser-style); use a non-browser client.
- Connection refused: the desktop app is not running, or the plugin is not enabled.
`;
}
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
export function checkRequest(req, token) {
    const remote = req.socket.remoteAddress ?? '';
    if (!(remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) {
        return { status: 403, message: 'loopback only' };
    }
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    if (!LOOPBACK_HOSTS.has(host))
        return { status: 403, message: 'bad Host header' };
    if (req.headers.origin !== undefined)
        return { status: 403, message: 'browser-origin requests are refused' };
    const auth = req.headers.authorization ?? '';
    const presented = Buffer.from(auth.startsWith('Bearer ') ? auth.slice(7).trim() : '');
    const expected = Buffer.from(token);
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        return { status: 401, message: 'missing or wrong bearer token' };
    }
    if (req.method === 'POST' && !(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        return { status: 415, message: 'POST requires application/json' };
    }
    return undefined;
}
