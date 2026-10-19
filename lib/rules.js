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
/** Writes inside the roots but outside the session's own scope. */
function outsideScope(target, g) {
    if (g.writeScope === undefined || g.writeScope.length === 0)
        return undefined;
    if (isWithinAny(g.writeScope, target, g.platform))
        return undefined;
    return deny('write-outside-scope', `this session may only write inside its own scope (${g.writeScope.join(', ')}); ${target} belongs to another part of the workspace`);
}
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
    return outsideScope(target, g) ?? allow('write-in-root');
}
// ── credentials and protected configuration ───────────────────────────────
const CREDENTIAL_SUFFIXES = [
    '.dsh/.credentials.yaml', '.ssh', '.codex/auth.json', '.claude/.credentials.json', '.aws/credentials',
    '.git-credentials', '.netrc', '.pypirc', '.npmrc', '.config/dsh-crew/.env', '.docker/config.json',
    // The orchestrator's MCP token: a worker holding it could approve its own calls.
    '.dsh/dujiangyan/token',
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
    if ((g.protectedDirs ?? []).some(d => target === `${slashLower(d).replace(/\/+$/, '')}/token`))
        return true;
    const base = target.slice(target.lastIndexOf('/') + 1);
    return base === '.env' || base.startsWith('.env.') || base === 'credentials.yaml' || base === '.credentials.json';
}
/** `.dsh/dujiangyan` is the plugin data dir: the MCP token and the personal rules workers must not loosen. */
const PROTECTED_CONFIG = ['.dsh/profiles', '.dsh/dujiangyan', '.claude/settings.json', '.claude/settings.local.json', '.codex/config.toml'];
function isProtectedConfig(p, g) {
    const target = slashLower(p);
    const home = slashLower(g.home).replace(/\/+$/, '');
    const under = (dir) => target === dir || target.startsWith(`${dir}/`);
    return PROTECTED_CONFIG.some(s => under(`${home}/${s}`)) || (g.protectedDirs ?? []).some(d => under(slashLower(d).replace(/\/+$/, '')));
}
// ── shell commands ─────────────────────────────────────────────────────────
/** Whole-command patterns that are always denied (lowercased, backslashes as `/`). */
const DENY_PATTERNS = [
    [/(\.dsh\/\.credentials|\.dsh\/dujiangyan\/token|\/\.ssh\/|\.codex\/auth|\.claude\/\.credentials|\.aws\/credentials|\.git-credentials|\.netrc|\.pypirc)/, 'credential-read', 'credential files are never readable by workers'],
    [/\bprintenv\b|(get-childitem|gci|dir|ls)\s+env:|\[(system\.)?environment\]::getenvironmentvariables|\$env:[a-z0-9_]*(key|token|secret|passw)/, 'env-dump', 'printing environment variables can leak API keys'],
    [/\.dsh\/profiles|\.dsh\/dujiangyan\/|local-rules\.json|cordis\.patch\.yml|\.claude\/settings|\.codex\/config\.toml/, 'config-write', 'harness, Claude and Codex configuration is reserved to the orchestrator'],
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
/** Placeholder left in a segment where a nested `( … )`, `{ … }` or `$( … )` was split out. */
const SUB = '$__djy_sub';
const SUB_RE = /\$__djy_sub/g;
const MAX_NESTING = 4;
/** Environment variables that change which program or library a later command loads. */
const LOADER_ENV = /^(path|pathext|comspec|psmodulepath|ld_preload|ld_library_path|dyld_\w+)$/i;
/** Side-effect-free .NET statics (namespace without `system.`, lowercase); `*` allows every member. */
const PURE_DOTNET = new Map([
    ...['math', 'int', 'int32', 'int64', 'uint32', 'uint64', 'double', 'decimal', 'string', 'char', 'bool', 'regex',
        'text.regularexpressions.regex', 'datetime', 'timespan', 'guid', 'convert', 'bitconverter', 'version']
        .map(t => [t, /./]),
    ['environment', /^(processorcount|machinename|osversion|is64bitoperatingsystem|is64bitprocess|newline|tickcount|tickcount64|currentdirectory)$/],
    ['io.path', /^(combine|join|getfilename|getfilenamewithoutextension|getextension|getdirectoryname|getfullpath|changeextension|ispathrooted|getpathroot|directoryseparatorchar)$/],
    ['io.driveinfo', /^(getdrives|new)$/],
    ['io.file', /^(exists|readalltext|readalllines|readallbytes)$/],
    ['io.directory', /^(exists|getfiles|getdirectories|enumeratefiles|enumeratedirectories)$/],
    ['text.encoding', /./],
    ['text.utf8encoding', /^new$/],
    ['diagnostics.stopwatch', /^(startnew|new|gettimestamp|frequency)$/],
    ['management.automation.language.parser', /^(parsefile|parseinput)$/],
]);
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
const GIT_LOCAL = new Set(['status', 'diff', 'log', 'show', 'add', 'commit', 'branch', 'checkout', 'switch', 'restore', 'stash', 'init', 'rev-parse', 'ls-files', 'blame', 'tag', 'worktree', 'mv', 'rm', 'describe', 'shortlog', 'reflog', 'cat-file', 'config',
    // read-only plumbing / inspection
    'rev-list', 'ls-tree', 'show-ref', 'for-each-ref', 'name-rev', 'merge-base', 'count-objects', 'grep', 'verify-pack', 'cherry', 'whatchanged']);
const GIT_NETWORK = new Set(['clone', 'fetch', 'pull', 'submodule', 'lfs', 'ls-remote']);
const CONTROL_WORDS = new Set(['foreach', 'for', 'if', 'elseif', 'else', 'try', 'catch', 'finally', 'while', 'do', 'switch', 'function', 'param', 'return', 'break', 'continue', 'begin', 'process', 'end', 'then', 'fi', 'done', 'esac', 'in', 'throw', 'trap']);
const PATH_PARAMS = new Set(['-path', '-literalpath', '-filepath', '-destination', '-outfile', '-outputpath', '-target']);
/** Parameters whose value is data, not a write target. */
const VALUE_PARAMS = new Set(['-value', '-encoding', '-itemtype', '-filter', '-include', '-exclude', '-delimiter', '-erroraction', '-pattern']);
/** PowerShell host options that take a value (`pwsh -ExecutionPolicy Bypass -File x.ps1`). */
const PWSH_VALUE_OPTIONS = new Set(['-executionpolicy', '-ep', '-ex', '-workingdirectory', '-wd', '-outputformat', '-of', '-inputformat', '-if', '-windowstyle', '-w', '-configurationname', '-settingsfile']);
const ESCAPE = { pwsh: '`', bash: '\\', cmd: '^' };
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
    return classifyCommand(command, { ...g, cwd }, tool === 'bash' ? 'bash' : 'pwsh');
}
/** Classify a full shell command line (bash or PowerShell dialect). */
export function classifyCommand(command, g, dialect = g.platform === 'win32' ? 'pwsh' : 'bash', depth = 0) {
    if (depth > MAX_NESTING)
        return escalate('nesting', 'the command nests shells too deeply to inspect');
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
    const vars = new Map();
    let worst = allow('shell-allowlist');
    for (const segment of splitSegments(command, dialect)) {
        const verdict = classifySegment(tokenizeRaw(segment, dialect), g, dialect, vars, depth);
        if (verdict.kind === 'deny')
            return verdict;
        if (verdict.kind === 'escalate' && worst.kind === 'allow')
            worst = verdict;
    }
    return worst;
}
/**
 * Split a command into simple commands: on unquoted `;`, `&&`, `||`, `|` and newlines (and `&` in
 * cmd), and around every nested `( … )`, `{ … }` and `$( … )` — also inside double quotes — and bash
 * backticks. A nested body becomes its own segment(s) and is classified like any other command; the
 * enclosing segment keeps a placeholder, so `Remove-Item (Join-Path a b)` still has an unresolvable
 * target. Quotes, escapes and here-strings (`@'…'@`) stay intact inside a segment.
 */
export function splitSegments(command, dialect = 'pwsh') {
    const out = [];
    const esc = ESCAPE[dialect];
    const frames = [];
    let buf = '';
    let close;
    let quote;
    const flush = () => {
        if (buf.trim() !== '')
            out.push(buf.trim());
        buf = '';
    };
    const open = (closer, outerQuote) => {
        buf += SUB;
        frames.push({ buf, close, quote: outerQuote });
        buf = '';
        close = closer;
        quote = undefined;
    };
    for (let i = 0; i < command.length; i++) {
        const c = command[i];
        const next = command[i + 1];
        if (quote !== undefined) {
            const literal = quote === '\'' || quote === '@\'';
            if (!literal && c === esc && next !== undefined) {
                buf += c + next;
                i++;
                continue;
            }
            if (quote.length === 2) {
                if (c === '\n' && command.startsWith(`${quote[1]}@`, i + 1)) {
                    buf += `${c}${quote[1]}@`;
                    i += 2;
                    quote = undefined;
                    continue;
                }
            }
            else if (c === quote) {
                buf += c;
                quote = undefined;
                continue;
            }
            if (!literal && c === '$' && next === '(') {
                i++;
                open(')', quote);
                continue;
            }
            if (!literal && dialect === 'bash' && c === '`') {
                open('`', quote);
                continue;
            }
            buf += c;
            continue;
        }
        if (close !== undefined && c === close) {
            flush();
            const frame = frames.pop();
            buf = frame.buf;
            close = frame.close;
            quote = frame.quote;
            continue;
        }
        if (c === esc && next !== undefined) {
            buf += c + next;
            i++;
            continue;
        }
        if (c === '@' && (next === '"' || next === '\'') && /^\r?\n/.test(command.slice(i + 2))) {
            quote = `@${next}`;
            buf += c + next;
            i++;
            continue;
        }
        if (c === '"' || (c === '\'' && dialect !== 'cmd')) {
            quote = c;
            buf += c;
            continue;
        }
        if (c === '$' && next === '{') {
            const end = command.indexOf('}', i);
            if (end > i) {
                buf += command.slice(i, end + 1);
                i = end;
                continue;
            }
        }
        if (c === '(' || c === '{') {
            open(c === '(' ? ')' : '}', undefined);
            continue;
        }
        if (dialect === 'bash' && c === '`') {
            open('`', undefined);
            continue;
        }
        if (c === ';' || c === '\n' || c === '\r' || c === '|' || (c === '&' && (next === '&' || dialect === 'cmd') && !buf.endsWith('>'))) {
            if ((c === '&' && next === '&') || (c === '|' && next === '|'))
                i++;
            flush();
            continue;
        }
        buf += c;
    }
    flush();
    while (frames.length > 0) {
        buf = frames.pop().buf;
        flush();
    }
    return out;
}
/** Whitespace tokenizer honoring quotes, escapes and here-strings; quotes are kept on the tokens. */
function tokenizeRaw(segment, dialect) {
    const out = [];
    const esc = ESCAPE[dialect];
    let current = '';
    let quote;
    let started = false;
    for (let i = 0; i < segment.length; i++) {
        const c = segment[i];
        const next = segment[i + 1];
        if (quote !== undefined) {
            current += c;
            const literal = quote === '\'' || quote === '@\'';
            if (!literal && c === esc && next !== undefined) {
                current += next;
                i++;
            }
            else if (quote.length === 2 ? c === '\n' && segment.startsWith(`${quote[1]}@`, i + 1) : c === quote) {
                if (quote.length === 2) {
                    current += `${quote[1]}@`;
                    i += 2;
                }
                quote = undefined;
            }
            continue;
        }
        if (c === '@' && (next === '"' || next === '\'') && /^\r?\n/.test(segment.slice(i + 2))) {
            quote = `@${next}`;
            current += c + next;
            started = true;
            i++;
            continue;
        }
        if (c === '"' || (c === '\'' && dialect !== 'cmd')) {
            quote = c;
            current += c;
            started = true;
            continue;
        }
        if (c === esc && next !== undefined) {
            current += c + next;
            i++;
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
/** Remove quoting and escapes from one raw token. */
function unquote(raw, dialect) {
    const here = /^@(["'])\r?\n([\s\S]*?)\r?\n\1@$/.exec(raw);
    if (here !== null)
        return here[2];
    const esc = ESCAPE[dialect];
    let out = '';
    let quote;
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (quote !== undefined) {
            if (c === quote)
                quote = undefined;
            else if (quote === '"' && c === esc && i + 1 < raw.length)
                out += raw[++i];
            else
                out += c;
            continue;
        }
        if (c === '"' || (c === '\'' && dialect !== 'cmd'))
            quote = c;
        else if (c === esc && i + 1 < raw.length)
            out += raw[++i];
        else
            out += c;
    }
    return out;
}
/** Whitespace tokenizer honoring single and double quotes (quotes removed). */
export function tokenize(segment, dialect = 'pwsh') {
    return tokenizeRaw(segment, dialect).map(t => unquote(t, dialect));
}
/**
 * The value of a token when it is fully known before the command runs: a quoted or bare literal,
 * with `$name` expanded only from earlier literal assignments. Anything computed at run time
 * (subexpressions, unknown variables, escapes) yields undefined.
 */
function literalValue(raw, vars, dialect) {
    if (raw.includes(SUB))
        return undefined;
    if (/^'[^']*'$/.test(raw) || raw.startsWith('@\''))
        return unquote(raw, dialect);
    const body = /^"([^"]*)"$/.exec(raw)?.[1] ?? (/^[^"'`\s]+$/.test(raw) ? raw : undefined);
    if (body === undefined || body.includes(ESCAPE[dialect]))
        return undefined;
    let unresolved = false;
    const value = body.replace(/\$\{?([A-Za-z_][\w:]*)\}?/g, (_, name) => {
        const v = vars.get(name.toLowerCase());
        if (v === undefined)
            unresolved = true;
        return v ?? '';
    });
    return unresolved ? undefined : value;
}
/** Split a raw token on commas outside quotes (`"a","b"` → two targets). */
function splitTopLevelCommas(raw) {
    const out = [];
    let current = '';
    let quote;
    for (const c of raw) {
        if (quote !== undefined) {
            if (c === quote)
                quote = undefined;
        }
        else if (c === '"' || c === '\'') {
            quote = c;
        }
        else if (c === ',') {
            out.push(current);
            current = '';
            continue;
        }
        current += c;
    }
    out.push(current);
    return out.filter(p => p !== '');
}
function commandName(token) {
    const base = token.replace(/\\/g, '/').split('/').pop() ?? token;
    return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1|com)$/, '');
}
/**
 * `[Console]::OutputEncoding = [Text.Encoding]::UTF8` (or InputEncoding) only changes this console's text
 * encoding. The right-hand side must itself be a plain encoding value, or a hidden .NET call could ride on it.
 */
function isConsoleEncoding(type, member, head, rest) {
    if (!/^(system\.)?console$/i.test(type) || !/^(output|input)encoding$/i.test(member))
        return false;
    const inline = /^\[[\w.]+\]::\w+=(.*)$/.exec(head);
    const value = inline !== null ? [inline[1], ...rest].join(' ') : rest[0] === '=' ? rest.slice(1).join(' ') : undefined;
    if (value === undefined)
        return false;
    // A parenthesized argument arrives as the nested-body placeholder; that body is classified as its own segment.
    return /^\s*\[(system\.)?text\.(encoding|utf8encoding)\]::\w+(\$__djy_sub)?\s*$/i.test(value);
}
function isPureDotnet(type, member) {
    const t = type.toLowerCase().replace(/^system\./, '');
    return PURE_DOTNET.get(t)?.test(member.toLowerCase()) === true;
}
const dynamicCommand = () => escalate('dynamic-command', 'the command name or script path is computed at run time (variable, subexpression or concatenation); call the program by its literal name or path');
function classifySegment(raw, g, dialect, vars, depth) {
    // Drop call operators, control-flow words, braces and assignments (remembering literal ones).
    let i = 0;
    let called = false;
    for (;;) {
        const t = raw[i];
        if (t === undefined)
            return allow('shell-neutral');
        if (t === '&' || t === '.') {
            called = true;
            i++;
            continue;
        }
        const bare = t.replace(SUB_RE, '').replace(/[{}()]/g, '').toLowerCase();
        if (t === '!' || /^[{}()]+$/.test(t) || (!called && bare !== '' && CONTROL_WORDS.has(bare))) {
            i++;
            continue;
        }
        let name;
        let rhs = [];
        if (/^\$[\w:]+$/.test(t) && (raw[i + 1] === '=' || raw[i + 1] === '+=')) {
            name = t.slice(1);
            rhs = raw.slice(i + 2);
            i += 2;
        }
        else {
            const m = /^\$([\w:]+)\+?=([\s\S]*)$/.exec(t);
            if (m !== null) {
                name = m[1];
                const value = m[2];
                rhs = value === '' ? raw.slice(i + 1) : [value, ...raw.slice(i + 1)];
                if (value === '')
                    i++;
                else
                    raw[i] = value;
            }
        }
        if (name !== undefined) {
            const lower = name.toLowerCase();
            if (lower.startsWith('env:') && LOADER_ENV.test(lower.slice(4))) {
                return escalate('env-loader', `setting $${name} changes which programs or libraries later commands load`);
            }
            const value = rhs.length === 1 ? literalValue(rhs[0], vars, dialect) : undefined;
            if (value === undefined)
                vars.delete(lower);
            else
                vars.set(lower, value);
            continue;
        }
        // `NAME=value`: a bash environment prefix, or an entry of a PowerShell hashtable literal.
        const prefix = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(t);
        if (prefix !== null && !called) {
            const key = prefix[1];
            if (dialect === 'bash') {
                if (LOADER_ENV.test(key))
                    return escalate('env-loader', `setting ${key} changes which programs or libraries later commands load`);
                const value = literalValue(prefix[2], vars, dialect);
                if (value === undefined)
                    vars.delete(key.toLowerCase());
                else
                    vars.set(key.toLowerCase(), value);
            }
            i++;
            continue;
        }
        break;
    }
    let head = raw[i];
    const rest = raw.slice(i + 1);
    if (called || dialect !== 'pwsh') {
        // `& $tool`, `& "path"`, or a bash/cmd command word: only literal names can be judged.
        if (!called && head === SUB)
            return allow('shell-group'); // a `( … )` / `{ … }` body, classified on its own
        const value = literalValue(head, vars, dialect);
        if (value === undefined)
            return dynamicCommand();
        head = value;
    }
    else {
        const dotnet = /^\[([\w.]+)\]::(\w+)/.exec(head);
        if (dotnet !== null && isConsoleEncoding(dotnet[1], dotnet[2], head, rest))
            return allow('console-encoding');
        if (dotnet !== null) {
            return isPureDotnet(dotnet[1], dotnet[2])
                ? allow('dotnet-pure')
                : escalate('dotnet-call', `direct .NET call ${head.replace(SUB_RE, '(…)').slice(0, 80)}`);
        }
        // A PowerShell value expression (string, number, variable, array, member access, operator), not a command.
        if (/^["'@$\d([\-+*/%,=<>!]|^\.[A-Za-z_]/.test(head))
            return allow('shell-expression');
    }
    const name = commandName(head);
    const args = rest.map(t => unquote(t, dialect));
    if (name === 'git')
        return classifyGit(args, g);
    if (name === 'curl' || name === 'wget' || name === 'invoke-webrequest' || name === 'invoke-restmethod' || name === 'iwr' || name === 'irm') {
        return escalate('network-read', `${name} reaches the network`);
    }
    if (name === 'cmd') {
        const k = args.findIndex(t => /^\/[ck]$/i.test(t));
        return k < 0 ? escalate('unknown-command', 'cmd without /c starts an interactive shell') : classifyNested(rest.slice(k + 1), dialect, 'cmd', g, depth);
    }
    if (name === 'pwsh' || name === 'powershell')
        return classifyPwshHost(rest, dialect, g, vars, depth);
    if ((name === 'bash' || name === 'sh') && args[0] === '-c')
        return classifyNested(rest.slice(1), dialect, 'bash', g, depth);
    if (name === 'pip' || name === 'pip3' || ((name === 'python' || name === 'python3' || name === 'py') && args[0] === '-m' && args[1] === 'pip')) {
        return args.includes('install') || args.includes('download')
            ? escalate('pip-install', 'pip install downloads packages from the network')
            : allow('pip-read');
    }
    if ((name === 'python' || name === 'python3' || name === 'py') && programArg(args) === '-') {
        return escalate('inline-stdin-code', 'python reads its program from stdin, which the gate cannot inspect');
    }
    if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'npx') {
        return escalate('node-package', `${name} may download and run packages`);
    }
    if (name === 'icacls')
        return allow('icacls-read'); // write forms are denied above
    if (name === 'fsutil') {
        return /^volume$/i.test(args[0] ?? '') && /^diskfree$/i.test(args[1] ?? '')
            ? allow('fsutil-diskfree')
            : escalate('unknown-command', `fsutil ${args[0] ?? ''} is not a recognized read-only form`);
    }
    if (name === 'powercfg') {
        return /^[/-](getactivescheme|list|l|query|q)$/i.test(args[0] ?? '')
            ? allow('powercfg-read')
            : escalate('unknown-command', `powercfg ${args[0] ?? ''} is not a recognized read-only form`);
    }
    if (/^(invoke-expression|iex|start-process|saps|start|new-object|add-type|invoke-command|icm|start-job)$/.test(name)) {
        return escalate('dynamic-exec', `${name} executes dynamic or out-of-band code`);
    }
    const allowed = ALLOW_COMMANDS.has(name) || READ_CMDLET.test(name) || (g.config?.allowCommands ?? []).includes(name);
    if (!allowed) {
        // A script or binary that lives inside the workspace (a build script, a cargo-built exe)
        // runs under the same OS write confinement as any allowed build command.
        if (/[\\/]/.test(head) && /\.(ps1|sh|bat|cmd|exe|py)$/i.test(head) && isWithinAny(g.roots, resolveIn(g, g.cwd, head), g.platform)) {
            return checkRedirects(rest, g, 'workspace-script', vars, dialect);
        }
        return escalate('unknown-command', `no rule recognizes command "${name}"`);
    }
    if (WRITE_COMMANDS.has(name))
        return checkWriteTargets(name, rest, g, vars, dialect);
    if (name === 'python' || name === 'python3' || name === 'py' || name === 'node')
        return checkRedirects(rest, g, 'run-script', vars, dialect);
    return checkRedirects(rest, g, `shell:${name}`, vars, dialect);
}
/** The program a python command line runs: a script path, `-` (stdin), or the `-c`/`-m` marker. */
function programArg(args) {
    for (const a of args) {
        if (a === '-' || a === '-c' || a === '-m')
            return a;
        if (!a.startsWith('-'))
            return a;
    }
    return undefined;
}
/** Classify the command string handed to a nested shell (`cmd /c …`, `pwsh -Command …`, `bash -c …`). */
function classifyNested(rawRest, outer, inner, g, depth) {
    if (rawRest.length === 0)
        return escalate('unknown-command', 'a nested shell without a command');
    let text = rawRest.length === 1 ? unquote(rawRest[0], outer) : rawRest.join(' ');
    if (rawRest.length > 1 && /^"[\s\S]*"$/.test(text))
        text = text.slice(1, -1);
    return classifyCommand(text, g, inner, depth + 1);
}
/** `pwsh`/`powershell` started as a child: judge its `-Command` text or `-File` script; anything else escalates. */
function classifyPwshHost(rest, outer, g, vars, depth) {
    for (let k = 0; k < rest.length; k++) {
        const t = unquote(rest[k], outer).toLowerCase();
        if (/^-(e|ec|en|enc|enco|encod|encode|encoded\w*)$/.test(t))
            return escalate('encoded-command', 'an encoded PowerShell command cannot be inspected');
        if (t === '-c' || t === '-command')
            return classifyNested(rest.slice(k + 1), outer, 'pwsh', g, depth);
        if (t === '-f' || t === '-file')
            return classifyScript(rest[k + 1], rest.slice(k + 2), g, vars, outer);
        if (PWSH_VALUE_OPTIONS.has(t)) {
            k++;
            continue;
        }
        if (t.startsWith('-'))
            continue;
        return classifyNested(rest.slice(k), outer, 'pwsh', g, depth); // a positional argument is the command
    }
    return escalate('unknown-command', 'a nested PowerShell without -Command or -File starts an interactive shell');
}
/** A script handed to a child shell: inside the workspace it runs like any workspace script. */
function classifyScript(raw, rest, g, vars, dialect) {
    const script = raw === undefined ? undefined : literalValue(raw, vars, dialect);
    if (script === undefined)
        return dynamicCommand();
    if (!isWithinAny(g.roots, resolveIn(g, g.cwd, script), g.platform)) {
        return escalate('script-outside-root', `script ${script} is outside the workspace roots`);
    }
    return checkRedirects(rest, g, 'workspace-script', vars, dialect);
}
/** git options that take a value before the subcommand (`git -C dir status`). */
const GIT_VALUE_OPTIONS = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace']);
function classifyGit(rest, g) {
    let sub;
    let subAt = -1;
    let outside;
    for (let i = 0; i < rest.length; i++) {
        const t = rest[i];
        if (GIT_VALUE_OPTIONS.has(t)) {
            const dir = rest[i + 1];
            if (t !== '-c' && t !== '--namespace' && dir !== undefined && !isWithinAny(g.roots, resolveIn(g, g.cwd, dir), g.platform)) {
                outside ??= dir;
            }
            i++;
            continue;
        }
        if (!t.startsWith('-')) {
            sub = t.toLowerCase();
            subAt = i;
            break;
        }
    }
    // Global options (`git -C dir push`) hide the subcommand from the deny patterns; re-check it here.
    const next = rest[subAt + 1]?.toLowerCase();
    if (sub === 'push' || (sub === 'remote' && next !== undefined && ['add', 'set-url', 'remove', 'rename'].includes(next)) ||
        (sub === 'config' && (next === '--global' || next === '--system'))) {
        return deny('git-remote', 'pushing or changing remotes/global git config is reserved to the orchestrator');
    }
    if (outside !== undefined)
        return escalate('git-outside-root', `git operates on ${outside}, outside the workspace roots`);
    if (sub === undefined)
        return allow('git-info');
    if (GIT_LOCAL.has(sub))
        return allow(`git-${sub}`);
    if (GIT_NETWORK.has(sub))
        return escalate('git-network', `git ${sub} reaches a remote`);
    return escalate('git-other', `git ${sub}`);
}
/** Judge one raw target token: resolve literals and earlier assignments, else it cannot be checked. */
function judgeRaw(raw, g, destructive, vars, dialect) {
    for (const piece of splitTopLevelCommas(raw)) {
        const value = literalValue(piece, vars, dialect);
        const v = value === undefined
            ? escalate('dynamic-target', `cannot resolve ${destructive ? 'delete/move' : 'write'} target "${piece.replace(SUB_RE, '(…)')}" statically`)
            : judgeTarget(value, g, destructive);
        if (v.kind !== 'allow')
            return v;
    }
    return allow('target-in-root');
}
/** Collect redirection targets (`> f`, `>> f`, `>f`, `2> f`) and judge them. */
function checkRedirects(rest, g, rule, vars, dialect) {
    for (let i = 0; i < rest.length; i++) {
        const t = rest[i];
        const m = /^\d?>>?(.*)$/.exec(t);
        if (m === null)
            continue;
        const target = m[1] !== '' ? m[1] : rest[i + 1];
        if (target === undefined || target === '&1' || target === '$null' || /^\/dev\/null$/i.test(target) || /^nul$/i.test(target))
            continue;
        const v = judgeRaw(target, g, false, vars, dialect);
        if (v.kind !== 'allow')
            return v;
    }
    return allow(rule);
}
function checkWriteTargets(name, rest, g, vars, dialect) {
    const redirect = checkRedirects(rest, g, `write:${name}`, vars, dialect);
    if (redirect.kind !== 'allow')
        return redirect;
    const destructive = DELETE_COMMANDS.has(name) || name === 'mv' || name === 'move' || name === 'move-item';
    const targets = [];
    for (let i = 0; i < rest.length; i++) {
        const t = rest[i];
        const lower = unquote(t, dialect).toLowerCase();
        if (PATH_PARAMS.has(lower)) {
            const v = rest[i + 1];
            if (v !== undefined)
                targets.push(v);
            i++;
            continue;
        }
        if (VALUE_PARAMS.has(lower)) {
            i++;
            continue;
        }
        if (t.startsWith('-') || (t.startsWith('/') && g.platform === 'win32' && t.length <= 3))
            continue; // flags, cmd-style switches
        // Redirects are judged by checkRedirects. A bare operator (> >> 2> *>) owns the next token; an attached
        // one (>f) or a stream merge (2>&1) is complete in itself and must not swallow the next target.
        if (/^(\d|\*)?>>?$/.test(t)) {
            i++;
            continue;
        }
        if (/^(\d|\*)?>>?/.test(t))
            continue;
        targets.push(t);
    }
    for (const target of targets) {
        const v = judgeRaw(target, g, destructive, vars, dialect);
        if (v.kind !== 'allow')
            return v;
    }
    return allow(`write:${name}`);
}
/** Judge one write/delete target path; environment references and globs above the last segment cannot be resolved statically. */
function judgeTarget(raw, g, destructive) {
    // A wildcard confined to the last path segment cannot reach outside its literal directory: judge the directory.
    const glob = /^([^$*?`%]*)[\\/]([^\\/]*[*?][^\\/]*)$/.exec(raw);
    if (glob !== null && !/[$`%]|^\(|^@\(/.test(raw) && glob[1] !== '')
        return judgeGlobDir(glob[1], g, destructive);
    if (/[$*?`%]|^\(|^@\(/.test(raw)) {
        return destructive
            ? escalate('dynamic-target', `cannot resolve delete/move target "${raw}" statically`)
            : escalate('dynamic-target', `cannot resolve write target "${raw}" statically`);
    }
    const target = resolveIn(g, g.cwd, raw);
    if (isCredentialPath(target, g))
        return deny('credential-write', 'credential files are never writable by workers');
    if (isProtectedConfig(target, g))
        return deny('config-write', 'harness, Claude and Codex configuration is reserved to the orchestrator');
    if (!isWithinAny(g.roots, target, g.platform)) {
        return deny('write-outside-root', `writes are confined to the workspace roots (${g.roots.join(', ')}); ${target} is outside`);
    }
    if (destructive && g.roots.some(root => isWithinAny([target], root, g.platform))) {
        return deny('delete-root', `refusing to delete or move a workspace root (${target})`);
    }
    return outsideScope(target, g) ?? allow('target-in-root');
}
/** `dir/*.log`: the wildcard only selects names inside `dir`, so `dir` decides; a wildcard over a whole root stays with an approver. */
function judgeGlobDir(rawDir, g, destructive) {
    const dir = resolveIn(g, g.cwd, rawDir);
    const probe = `${dir}${g.platform === 'win32' ? '\\' : '/'}x`;
    if (isCredentialPath(probe, g) || isCredentialPath(dir, g))
        return deny('credential-write', 'credential files are never writable by workers');
    if (isProtectedConfig(probe, g))
        return deny('config-write', 'harness, Claude and Codex configuration is reserved to the orchestrator');
    if (!isWithinAny(g.roots, dir, g.platform)) {
        return deny('write-outside-root', `writes are confined to the workspace roots (${g.roots.join(', ')}); ${dir} is outside`);
    }
    if (destructive && g.roots.some(root => isWithinAny([dir], root, g.platform))) {
        return escalate('dynamic-target', `a wildcard delete/move over a whole workspace root (${dir})`);
    }
    return outsideScope(dir, g) ?? allow('target-glob-in-root');
}
