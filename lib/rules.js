/**
 * 飞沙堰 (Feishayan) — the deterministic rule tier of the permission gate.
 *
 * `classify` is a pure function of one tool call and its session context. It
 * returns `allow`, `deny` (with a reason the model can act on) or `escalate`
 * (an external approver must decide). Rules are deliberately conservative:
 * anything this module does not positively recognize escalates, and the
 * approver — not this file — decides the grey zone.
 */
import { canonicalPath, isWithinAny, pathApi } from "./paths.js";
const allow = (rule) => ({ kind: 'allow', rule });
const deny = (rule, reason) => ({ kind: 'deny', rule, reason });
const escalate = (rule, reason) => ({ kind: 'escalate', rule, reason });
// ── tools ──────────────────────────────────────────────────────────────────
const READ_TOOLS = new Set([
    'read', 'read_image', 'glob', 'grep', 'todo_write', 'present', 'exit_plan_mode', 'lsp',
    'list_agents', 'list_subagent_models', 'job_list', 'job_output', 'terminal_list', 'terminal_read',
    'get_goal', 'session_event_read', 'session_event_search', 'session_event_trace', 'session_search', 'session_trace',
    'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
    'team_task_get', 'team_task_list', 'wait_agent',
]);
const COORDINATION_TOOLS = new Set(['send_message', 'interrupt_agent', 'team_task_create', 'team_task_update']);
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor']);
const SHELL_TOOLS = new Set(['bash', 'pwsh']);
const SUBAGENT_TOOLS = new Set(['subagent', 'subagent_fork', 'spawn_teammate', 'ralph', 'workflow']);
const FORBIDDEN_TOOLS = new Map([
    ['plugin_manager', 'changing plugins affects every session; ask the orchestrator'],
    ['plugin_market', 'installing plugins is reserved to the orchestrator'],
    ['cordis_inspect_list', 'runtime inspection is reserved to the orchestrator'],
    ['cordis_inspect_query', 'runtime inspection is reserved to the orchestrator'],
    ['schedule_create', 'workers must not create persistent schedules'],
    ['schedule_update', 'workers must not change persistent schedules'],
    ['schedule_delete', 'workers must not change persistent schedules'],
    ['ask_user_question', 'this is an unattended worker; put open questions in your final summary instead'],
]);
/** The reserved PTC transport; its program body bypasses per-call gating. */
export const RUN_CODE = 'run_code';
/**
 * Classify one tool call.
 * @param tool - model-visible tool name.
 * @param args - the call's arguments (`exec.arguments`).
 * @param g - session context.
 * @param outerRunCode - true when this is an outer `run_code` call (not a PTC inner call).
 */
export function classify(tool, args, g, outerRunCode = false) {
    if (tool === RUN_CODE && outerRunCode) {
        return deny('run-code', 'run_code is disabled for dispatched workers because its program body is not gated; call the native tools (read/write/edit/pwsh/bash) directly');
    }
    const forbidden = FORBIDDEN_TOOLS.get(tool);
    if (forbidden !== undefined)
        return deny(`tool:${tool}`, forbidden);
    if (SUBAGENT_TOOLS.has(tool)) {
        return g.config?.allowSubagents === true
            ? allow('subagent-allowed')
            : deny('subagent', 'workers may not start their own subagents; the orchestrator assigns parallel work');
    }
    if (READ_TOOLS.has(tool))
        return classifyRead(tool, args, g);
    if (COORDINATION_TOOLS.has(tool))
        return allow('coordination');
    if (WRITE_TOOLS.has(tool))
        return classifyWrite(args, g);
    if (SHELL_TOOLS.has(tool))
        return classifyShell(tool, args, g);
    if (tool === 'web_search') {
        return g.config?.allowWebSearch === false ? escalate('web-search', 'web search needs approval in this deployment') : allow('web-search');
    }
    if (tool === 'web_fetch')
        return escalate('web-fetch', 'fetching a URL reaches the network');
    if (tool.startsWith('mcp__'))
        return escalate('mcp-tool', `external MCP tool ${tool}`);
    return escalate('unknown-tool', `no rule recognizes tool "${tool}"`);
}
function stringArg(args, ...names) {
    for (const name of names) {
        const v = args[name];
        if (typeof v === 'string' && v !== '')
            return v;
    }
    return undefined;
}
function resolveIn(g, base, p) {
    const api = pathApi(g.platform);
    const absolute = api.isAbsolute(p) ? p : api.resolve(base, p);
    return (g.canonical ?? (q => canonicalPath(q, g.platform)))(absolute);
}
function classifyRead(tool, args, g) {
    const p = stringArg(args, 'file_path', 'path');
    if (p !== undefined && isCredentialPath(resolveIn(g, g.cwd, p), g)) {
        return deny('credential-read', 'reading credential files is never allowed for workers');
    }
    return allow(`read:${tool}`);
}
function classifyWrite(args, g) {
    const p = stringArg(args, 'file_path', 'path');
    if (p === undefined)
        return escalate('write-no-path', 'write without a recognizable file_path');
    const target = resolveIn(g, g.cwd, p);
    if (isCredentialPath(target, g))
        return deny('credential-write', 'writing credential files is never allowed for workers');
    if (isProtectedConfig(target, g))
        return deny('config-write', 'harness, Claude and Codex configuration is reserved to the orchestrator');
    if (!isWithinAny(g.roots, target, g.platform)) {
        return deny('write-outside-root', `writes are confined to the workspace roots (${g.roots.join(', ')}); ${target} is outside`);
    }
    return allow('write-in-root');
}
// ── credentials and protected configuration ───────────────────────────────
const CREDENTIAL_SUFFIXES = [
    '.dsh/.credentials.yaml', '.ssh', '.codex/auth.json', '.claude/.credentials.json', '.aws/credentials',
    '.git-credentials', '.netrc', '.pypirc', '.npmrc', '.config/dsh-crew/.env', '.docker/config.json',
];
function slashLower(p) {
    return p.replace(/\\/g, '/').toLowerCase();
}
export function isCredentialPath(p, g) {
    const target = slashLower(p);
    const home = slashLower(g.home).replace(/\/+$/, '');
    for (const suffix of CREDENTIAL_SUFFIXES) {
        const full = `${home}/${suffix}`;
        if (target === full || target.startsWith(`${full}/`))
            return true;
    }
    const base = target.slice(target.lastIndexOf('/') + 1);
    return base === '.env' || base.startsWith('.env.') || base === 'credentials.yaml' || base === '.credentials.json';
}
const PROTECTED_CONFIG = ['.dsh/profiles', '.claude/settings.json', '.claude/settings.local.json', '.codex/config.toml'];
function isProtectedConfig(p, g) {
    const target = slashLower(p);
    const home = slashLower(g.home).replace(/\/+$/, '');
    return PROTECTED_CONFIG.some(s => target === `${home}/${s}` || target.startsWith(`${home}/${s}/`));
}
// ── shell commands ─────────────────────────────────────────────────────────
/** Whole-command patterns that are always denied (lowercased, backslashes as `/`). */
const DENY_PATTERNS = [
    [/(\.dsh\/\.credentials|\/\.ssh\/|\.codex\/auth|\.claude\/\.credentials|\.aws\/credentials|\.git-credentials|\.netrc|\.pypirc)/, 'credential-read', 'credential files are never readable by workers'],
    [/\bprintenv\b|(get-childitem|gci|dir|ls)\s+env:|\[(system\.)?environment\]::getenvironmentvariables|\$env:[a-z0-9_]*(key|token|secret|passw)/, 'env-dump', 'printing environment variables can leak API keys'],
    [/\.dsh\/profiles|cordis\.patch\.yml|\.claude\/settings|\.codex\/config\.toml/, 'config-write', 'harness, Claude and Codex configuration is reserved to the orchestrator'],
    [/\bnpm\s+(i|install|add)\b[^;|&]*\s(-g|--global)\b|\b(pnpm|yarn)\s+(add\s+)?(-g|--global|global)\b|\bcargo\s+install\b|\bpip3?\s+install\b[^;|&]*--user\b/, 'global-install', 'global installs change the machine; install inside the workspace (venv / local node_modules) or ask the orchestrator'],
    [/\b(winget|choco|scoop|brew|apt|apt-get|yum|dnf|pacman)\s+(install|upgrade|uninstall|remove)\b/, 'system-install', 'system package installs are reserved to the user'],
    [/\breg(\.exe)?\s+(add|delete|import|load)\b|\b(set|new|remove)-itemproperty\b[^;|&]*\bhk(lm|cu|ey_)|\bsetx\b|\bset-executionpolicy\b/, 'registry', 'registry and machine settings are reserved to the user'],
    [/\b(bcdedit|diskpart|format-volume|stop-computer|restart-computer|new-service)\b|\bshutdown(\.exe)?\s|\bsc(\.exe)?\s+(create|delete|config)\b|\bschtasks(\.exe)?\s+\/create\b/, 'system-control', 'system control commands are reserved to the user'],
    [/\b(takeown|cacls|set-acl|chattr|chown)\b|\bicacls\b[^;|&]*\/(grant|deny|remove|reset|setintegritylevel|inheritance|setowner)/, 'acl', 'permission/ACL changes are an environment issue: stop, report it in your summary, and let the orchestrator fix it'],
    [/\bgit\s+push\b|\bgit\s+remote\s+(add|set-url|remove|rename)\b|\bgit\s+config\s+--(global|system)\b/, 'git-remote', 'pushing or changing remotes/global git config is reserved to the orchestrator'],
    [/\b(scp|sftp|ftp)(\.exe)?\s|\brsync\b[^;|&]*\s\S+:|\bnc(\.exe)?\s+-|\bwget\b[^;|&]*--post/, 'upload', 'uploading data off this machine is not allowed'],
    [/\b(invoke-webrequest|invoke-restmethod|iwr|irm)\b[^;|&]*\s-(method\s+(post|put|patch|delete)|infile|body)\b/, 'upload', 'sending data to remote endpoints is not allowed'],
];
/** curl upload flags are case-sensitive (`-f` fails fast, `-F` posts a form). */
const CURL_UPLOAD = /\bcurl(\.exe)?\b[^;|&]*\s(-T|--upload-file|-d|--data\S*|-F|--form|-X\s*(POST|PUT|PATCH|DELETE))(\s|=|$)/;
const BENCH_PATTERNS = [/\bcargo\s+bench\b/, /\bbench(mark)?[\w-]*\.(py|ps1|sh)\b/, /\bcriterion\b/];
/** Commands that read, build or run workspace code — writes are still confined by the OS sandbox. */
const ALLOW_COMMANDS = new Set([
    'cargo', 'rustc', 'rustfmt', 'rustup', 'python', 'python3', 'py', 'node', 'cmake', 'ninja', 'make', 'nmake', 'msbuild',
    'nvidia-smi',
    // read-only / informational
    'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'sort', 'uniq', 'find', 'findstr', 'grep', 'rg', 'where', 'which',
    'echo', 'pwd', 'cd', 'pushd', 'popd', 'hostname', 'whoami', 'systeminfo', 'tasklist', 'ps', 'du', 'df', 'tree', 'file',
    'date', 'time', 'sleep', 'true', 'false', 'test', 'diff', 'fc', 'certutil', 'sha256sum', 'md5sum', 'nproc', 'uname',
    // workspace file mutation (targets are checked separately)
    'mkdir', 'md', 'touch', 'cp', 'copy', 'xcopy', 'robocopy', 'mv', 'move', 'ren', 'rename', 'tee', 'rm', 'del', 'erase', 'rd', 'rmdir', 'chmod',
    'tar', 'unzip', 'zip', '7z', 'gzip', 'gunzip', 'zstd',
]);
const READ_CMDLET = /^(get|test|resolve|split|join|select|sort|where|foreach|format|out-string|out-null|measure|compare|group|convertto|convertfrom|write-output|write-host|write-verbose|write-information|write-progress|start-sleep|new-timespan|import-csv|export-csv|tee-object|out-file|set-content|add-content|new-item|copy-item|move-item|rename-item|remove-item|set-location|push-location|pop-location|clear-content|expand-archive|compress-archive)(-|$)/;
const WRITE_COMMANDS = new Set([
    'mkdir', 'md', 'touch', 'cp', 'copy', 'xcopy', 'robocopy', 'mv', 'move', 'ren', 'rename', 'tee', 'rm', 'del', 'erase', 'rd', 'rmdir', 'chmod',
    'tee-object', 'out-file', 'set-content', 'add-content', 'new-item', 'copy-item', 'move-item', 'rename-item', 'remove-item', 'clear-content',
    'export-csv', 'expand-archive', 'compress-archive',
]);
const DELETE_COMMANDS = new Set(['rm', 'del', 'erase', 'rd', 'rmdir', 'remove-item', 'clear-content']);
const GIT_LOCAL = new Set(['status', 'diff', 'log', 'show', 'add', 'commit', 'branch', 'checkout', 'switch', 'restore', 'stash', 'init', 'rev-parse', 'ls-files', 'blame', 'tag', 'worktree', 'mv', 'rm', 'describe', 'shortlog', 'reflog', 'cat-file', 'config']);
const GIT_NETWORK = new Set(['clone', 'fetch', 'pull', 'submodule', 'lfs', 'ls-remote']);
const CONTROL_WORDS = new Set(['foreach', 'for', 'if', 'elseif', 'else', 'try', 'catch', 'finally', 'while', 'do', 'switch', 'function', 'param', 'return', 'break', 'continue', 'begin', 'process', 'end', 'then', 'fi', 'done', 'esac', 'in']);
const PATH_PARAMS = new Set(['-path', '-literalpath', '-filepath', '-destination', '-outfile', '-outputpath', '-target']);
function classifyShell(tool, args, g) {
    if (args['sandbox_permissions'] !== undefined) {
        return escalate('sandbox-escalation', `the call asks to widen its sandbox (${String(args['sandbox_permissions'])}): ${String(args['justification'] ?? '')}`);
    }
    const command = stringArg(args, 'command');
    if (command === undefined)
        return escalate('shell-empty', `${tool} call without a command`);
    let cwd = g.cwd;
    const workdir = stringArg(args, 'workdir');
    if (workdir !== undefined) {
        cwd = resolveIn(g, g.cwd, workdir);
        if (!isWithinAny(g.roots, cwd, g.platform))
            return escalate('workdir-outside-root', `working directory ${cwd} is outside the workspace roots`);
    }
    return classifyCommand(command, { ...g, cwd });
}
/** Classify a full shell command line (bash or PowerShell dialect). */
export function classifyCommand(command, g) {
    const normalized = command.replace(/\\/g, '/').toLowerCase();
    for (const [re, rule, reason] of DENY_PATTERNS) {
        if (re.test(normalized))
            return deny(rule, reason);
    }
    if (CURL_UPLOAD.test(command))
        return deny('upload', 'sending data with curl is not allowed');
    for (const source of g.config?.denyPatterns ?? []) {
        if (new RegExp(source, 'i').test(command))
            return deny('custom-deny', `matches deny pattern /${source}/`);
    }
    const bench = [...BENCH_PATTERNS, ...(g.config?.benchPatterns ?? []).map(s => new RegExp(s, 'i'))];
    if (!g.holdsBench && bench.some(re => re.test(normalized))) {
        return deny('bench-lease', 'benchmark commands need the exclusive "bench" lease; submit this step as a task with resources ["bench"] (or wait for the current holder) instead of running it now');
    }
    let worst = allow('shell-allowlist');
    for (const segment of splitSegments(command)) {
        const verdict = classifySegment(tokenize(segment), g);
        if (verdict.kind === 'deny')
            return verdict;
        if (verdict.kind === 'escalate' && worst.kind === 'allow')
            worst = verdict;
    }
    return worst;
}
/** Split on unquoted `;`, `&&`, `||`, `|` and newlines. */
export function splitSegments(command) {
    const out = [];
    let current = '';
    let quote;
    for (let i = 0; i < command.length; i++) {
        const c = command[i];
        if (quote !== undefined) {
            current += c;
            if (c === quote)
                quote = undefined;
            continue;
        }
        if (c === '"' || c === '\'') {
            quote = c;
            current += c;
            continue;
        }
        if (c === ';' || c === '\n' || c === '\r' || c === '|' || (c === '&' && command[i + 1] === '&')) {
            if (c === '&' || (c === '|' && command[i + 1] === '|'))
                i++;
            if (current.trim() !== '')
                out.push(current.trim());
            current = '';
            continue;
        }
        current += c;
    }
    if (current.trim() !== '')
        out.push(current.trim());
    return out;
}
/** Whitespace tokenizer honoring single and double quotes (quotes removed). */
export function tokenize(segment) {
    const out = [];
    let current = '';
    let quote;
    let started = false;
    for (const c of segment) {
        if (quote !== undefined) {
            if (c === quote)
                quote = undefined;
            else
                current += c;
            continue;
        }
        if (c === '"' || c === '\'') {
            quote = c;
            started = true;
            continue;
        }
        if (/\s/.test(c)) {
            if (started || current !== '')
                out.push(current);
            current = '';
            started = false;
            continue;
        }
        current += c;
    }
    if (started || current !== '')
        out.push(current);
    return out;
}
function commandName(token) {
    const base = token.replace(/\\/g, '/').split('/').pop() ?? token;
    return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1|com)$/, '');
}
function classifySegment(tokens, g) {
    // Drop PowerShell call operators, control-flow words, braces and `$x =` assignments.
    let i = 0;
    for (;;) {
        const t = tokens[i];
        if (t === undefined)
            return allow('shell-neutral');
        const lower = t.toLowerCase();
        if (t === '&' || t === '.' || /^[{}()]+$/.test(t) || CONTROL_WORDS.has(lower.replace(/[{}()]/g, ''))) {
            i++;
            continue;
        }
        if (/^\$[\w:]+$/.test(t) && (tokens[i + 1] === '=' || tokens[i + 1] === '+=')) {
            i += 2;
            continue;
        }
        if (/^\$[\w:]+[+]?=/.test(t)) {
            tokens[i] = t.replace(/^\$[\w:]+[+]?=/, '');
            if (tokens[i] === '')
                i++;
            continue;
        }
        break;
    }
    const head = tokens[i];
    const rest = tokens.slice(i + 1);
    if (/^[@$]?\(|^["']|^\$|^\d|^\[|^@\{/.test(head) && !/^\[[\w.]+\]::/.test(head)) {
        return allow('shell-expression'); // a value expression, not a command
    }
    if (/^\[[\w.]+\]::/.test(head))
        return escalate('dotnet-call', `direct .NET call ${head.slice(0, 80)}`);
    const name = commandName(head);
    if (name === 'git')
        return classifyGit(rest);
    if (name === 'curl' || name === 'wget' || name === 'invoke-webrequest' || name === 'invoke-restmethod' || name === 'iwr' || name === 'irm') {
        return escalate('network-read', `${name} reaches the network`);
    }
    if (name === 'pip' || name === 'pip3' || ((name === 'python' || name === 'python3' || name === 'py') && rest[0] === '-m' && rest[1] === 'pip')) {
        return rest.includes('install') || rest.includes('download')
            ? escalate('pip-install', 'pip install downloads packages from the network')
            : allow('pip-read');
    }
    if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'npx') {
        return escalate('node-package', `${name} may download and run packages`);
    }
    if (name === 'icacls')
        return allow('icacls-read'); // write forms are denied above
    if (/^(invoke-expression|iex|start-process|saps|start|new-object|add-type|invoke-command|icm|start-job)$/.test(name)) {
        return escalate('dynamic-exec', `${name} executes dynamic or out-of-band code`);
    }
    const allowed = ALLOW_COMMANDS.has(name) || READ_CMDLET.test(name) || (g.config?.allowCommands ?? []).includes(name);
    if (!allowed) {
        // A script or binary that lives inside the workspace (a build script, a cargo-built exe)
        // runs under the same OS write confinement as any allowed build command.
        if (/[\\/]/.test(head) && /\.(ps1|sh|bat|cmd|exe|py)$/i.test(head) && isWithinAny(g.roots, resolveIn(g, g.cwd, head), g.platform)) {
            return checkRedirects(rest, g, 'workspace-script');
        }
        return escalate('unknown-command', `no rule recognizes command "${name}"`);
    }
    if (WRITE_COMMANDS.has(name))
        return checkWriteTargets(name, rest, g);
    if (name === 'python' || name === 'python3' || name === 'py' || name === 'node')
        return checkRedirects(rest, g, 'run-script');
    return checkRedirects(rest, g, `shell:${name}`);
}
function classifyGit(rest) {
    const sub = rest.find(t => !t.startsWith('-'))?.toLowerCase();
    if (sub === undefined)
        return allow('git-info');
    if (GIT_LOCAL.has(sub))
        return allow(`git-${sub}`);
    if (GIT_NETWORK.has(sub))
        return escalate('git-network', `git ${sub} reaches a remote`);
    return escalate('git-other', `git ${sub}`);
}
/** Collect redirection targets (`> f`, `>> f`, `>f`, `2> f`) and judge them. */
function checkRedirects(rest, g, rule) {
    for (let i = 0; i < rest.length; i++) {
        const t = rest[i];
        const m = /^\d?>>?(.*)$/.exec(t);
        if (m === null)
            continue;
        const target = m[1] !== '' ? m[1] : rest[i + 1];
        if (target === undefined || target === '&1' || target === '$null' || /^\/dev\/null$/i.test(target) || /^nul$/i.test(target))
            continue;
        const v = judgeTarget(target, g, false);
        if (v.kind !== 'allow')
            return v;
    }
    return allow(rule);
}
function checkWriteTargets(name, rest, g) {
    const redirect = checkRedirects(rest, g, `write:${name}`);
    if (redirect.kind !== 'allow')
        return redirect;
    const destructive = DELETE_COMMANDS.has(name) || name === 'mv' || name === 'move' || name === 'move-item';
    const targets = [];
    for (let i = 0; i < rest.length; i++) {
        const t = rest[i];
        const lower = t.toLowerCase();
        if (PATH_PARAMS.has(lower)) {
            const v = rest[i + 1];
            if (v !== undefined)
                targets.push(v);
            i++;
            continue;
        }
        if (t.startsWith('-') || (t.startsWith('/') && g.platform === 'win32' && t.length <= 3))
            continue; // flags, cmd-style switches
        if (/^\d?>>?/.test(t)) {
            i++;
            continue;
        }
        targets.push(t);
    }
    for (const target of targets) {
        for (const piece of target.split(',')) {
            if (piece === '')
                continue;
            const v = judgeTarget(piece, g, destructive);
            if (v.kind !== 'allow')
                return v;
        }
    }
    return allow(`write:${name}`);
}
/** Judge one write/delete target path; variables and globs cannot be resolved statically. */
function judgeTarget(raw, g, destructive) {
    if (/[$*?`%]|^\(|^@\(/.test(raw)) {
        return destructive
            ? escalate('dynamic-target', `cannot resolve delete/move target "${raw}" statically`)
            : escalate('dynamic-target', `cannot resolve write target "${raw}" statically`);
    }
    const target = resolveIn(g, g.cwd, raw);
    if (isCredentialPath(target, g))
        return deny('credential-write', 'credential files are never writable by workers');
    if (!isWithinAny(g.roots, target, g.platform)) {
        return deny('write-outside-root', `writes are confined to the workspace roots (${g.roots.join(', ')}); ${target} is outside`);
    }
    if (destructive && g.roots.some(root => isWithinAny([target], root, g.platform))) {
        return deny('delete-root', `refusing to delete or move a workspace root (${target})`);
    }
    return allow('target-in-root');
}
