/**
 * 飞沙堰 (Feishayan) — the deterministic rule tier of the permission gate.
 *
 * `classify` is a pure function of one tool call and its session context. It
 * returns `allow`, `deny` (with a reason the model can act on) or `escalate`
 * (an external approver must decide). Rules are deliberately conservative:
 * anything this module does not positively recognize escalates, and the
 * approver — not this file — decides the grey zone.
 */
import { canonicalPath, isWithinAny, pathApi, type Platform } from './paths.ts'

export type Verdict =
  | { readonly kind: 'allow'; readonly rule: string }
  | { readonly kind: 'deny'; readonly rule: string; readonly reason: string }
  | { readonly kind: 'escalate'; readonly rule: string; readonly reason: string }

export interface RuleConfig {
  /** Extra first tokens treated like the built-in allowlist (lowercase, no extension). */
  readonly allowCommands?: readonly string[]
  /** Extra regular expressions (case-insensitive) that deny a shell command. */
  readonly denyPatterns?: readonly string[]
  /** Extra regular expressions marking benchmark commands that need the bench lease. */
  readonly benchPatterns?: readonly string[]
  /** Allow `web_search` without approval (default true); `web_fetch` always escalates. */
  readonly allowWebSearch?: boolean
  /** Allow agents to start their own subagents (default false). */
  readonly allowSubagents?: boolean
  /** Loader-environment changes that are allowed (e.g. prepending a known Python to PATH). */
  readonly allowEnv?: readonly AllowEnv[]
  /** Programs outside the workspace roots that may run, by exact path (e.g. a batch-mode CAD tool). */
  readonly allowPrograms?: readonly AllowProgram[]
}

/**
 * One allowed loader-environment assignment. `prepend`/`append`: the new value must be the current
 * one (`$env:PATH`) with only these directories added; `values`: it must equal one of these exactly.
 */
export interface AllowEnv {
  readonly name: string
  readonly prepend?: readonly string[]
  readonly append?: readonly string[]
  readonly values?: readonly string[]
}

/**
 * One program outside the roots that may run. `args` (case-insensitive regex) must match its
 * argument line; the script after `scriptFlag` (e.g. `-r`) must be a literal path inside the roots.
 */
export interface AllowProgram {
  readonly path: string
  readonly args?: string
  readonly scriptFlag?: string
}

export interface GateContext {
  /** Canonical working directory of the calling session. */
  readonly cwd: string
  /** Canonical workspace roots writes are confined to. */
  readonly roots: readonly string[]
  /** The user's home directory (for credential paths). */
  readonly home: string
  readonly platform: Platform
  /** Whether the calling session's current task holds the `bench` lease. */
  readonly holdsBench: boolean
  readonly config?: RuleConfig
  /** Path canonicalizer; defaults to resolving symlinks on the host. */
  readonly canonical?: (p: string) => string
  /** Extra directories workers may never write (the plugin data dir: token, personal rules). */
  readonly protectedDirs?: readonly string[]
  /**
   * The calling session's own write scope (canonical, inside the roots). Workers sharing a root
   * otherwise write each other's files (prior art: dsh-crew cwd-lock, a real half-written file).
   */
  readonly writeScope?: readonly string[]
  /**
   * Reads a workspace script that a command dot-sources (`. ./tools/common.ps1`), so the functions it
   * defines are known to the rest of that command. Returns undefined when unreadable or too large.
   */
  readonly readScript?: (absolutePath: string) => string | undefined
  /**
   * Whether a directory exists now. An unconditional `cd` into an existing directory surely moves the
   * shell; without this (or for a missing one) the gate also keeps the old directory as possible.
   */
  readonly isDirectory?: (absolutePath: string) => boolean
  /**
   * The top of the git work tree containing a directory (the nearest ancestor with `.git`), or
   * undefined when there is none. A branch switch rewrites that whole tree, not just the cwd.
   */
  readonly gitTopLevel?: (absolutePath: string) => string | undefined
  /**
   * The session's effective sandbox mode, read from the host for this call; undefined when it could
   * not be read. A `sandbox_permissions` request equal to it widens nothing (the host returns it
   * without approval), so the call is judged as if the field were absent (findings 57).
   */
  readonly sandboxMode?: string
}

/** Writes inside the roots but outside the session's own scope. */
function outsideScope(target: string, g: GateContext): Verdict | undefined {
  if (g.writeScope === undefined || g.writeScope.length === 0) return undefined
  if (isWithinAny(g.writeScope, target, g.platform)) return undefined
  return deny('write-outside-scope', `this session may only write inside its own scope (${g.writeScope.join(', ')}); ${target} belongs to another part of the workspace`)
}

const allow = (rule: string): Verdict => ({ kind: 'allow', rule })
const deny = (rule: string, reason: string): Verdict => ({ kind: 'deny', rule, reason })
const escalate = (rule: string, reason: string): Verdict => ({ kind: 'escalate', rule, reason })

// ── tools ──────────────────────────────────────────────────────────────────

const READ_TOOLS = new Set([
  'read', 'read_image', 'glob', 'grep', 'todo_write', 'present', 'exit_plan_mode', 'lsp',
  'list_agents', 'list_subagent_models', 'job_list', 'job_output', 'terminal_list', 'terminal_read',
  'get_goal', 'session_event_read', 'session_event_search', 'session_event_trace', 'session_search', 'session_trace',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  'team_task_get', 'team_task_list', 'wait_agent',
  // Host built-in: returns paths of the bundled Python/Node runtime; changes neither PATH nor packages.
  'load_workspace_dependencies',
])
const COORDINATION_TOOLS = new Set(['send_message', 'interrupt_agent', 'team_task_create', 'team_task_update',
  // Stops a background job of the calling session itself (the host scopes job ids to the session).
  'job_kill'])
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
const SHELL_TOOLS = new Set(['bash', 'pwsh'])
const SUBAGENT_TOOLS = new Set(['subagent', 'subagent_fork', 'spawn_teammate', 'ralph', 'workflow'])
const FORBIDDEN_TOOLS = new Map([
  ['plugin_manager', 'changing plugins affects every session; ask the orchestrator'],
  ['plugin_market', 'installing plugins is reserved to the orchestrator'],
  ['cordis_inspect_list', 'runtime inspection is reserved to the orchestrator'],
  ['cordis_inspect_query', 'runtime inspection is reserved to the orchestrator'],
  ['schedule_create', 'workers must not create persistent schedules'],
  ['schedule_update', 'workers must not change persistent schedules'],
  ['schedule_delete', 'workers must not change persistent schedules'],
  ['ask_user_question', 'this is an unattended worker; put open questions in your final summary instead'],
  // A goal makes the host start further turns on its own, outside the dispatched task.
  ['create_goal', 'the dispatcher already tracks this task and continues it if a reply is cut off; do the work in this turn and end with the summary'],
  ['update_goal', 'goals are not used in dispatched tasks; the dispatcher tracks the task'],
])

/**
 * Tool names of other agent hosts (Claude Code, Codex) that models trained on them sometimes call
 * here (findings 55). The host has no such tool, so the call fails anyway: refuse it at once with the
 * name to use instead of holding it for an approver.
 */
const FOREIGN_TOOLS = new Map([
  ['Bash', 'pwsh (on Windows) or bash'], ['PowerShell', 'pwsh'], ['shell', 'pwsh (on Windows) or bash'], ['exec_command', 'pwsh (on Windows) or bash'],
  ['Read', 'read (images: read_image)'], ['Write', 'write'], ['Edit', 'edit'], ['MultiEdit', 'edit (one exact replacement per call)'],
  ['apply_patch', 'edit (one exact replacement per call) or write'], ['Grep', 'grep'], ['Glob', 'glob'], ['LS', 'glob or pwsh Get-ChildItem'],
  ['TodoWrite', 'todo_write'], ['WebFetch', 'web_fetch'], ['WebSearch', 'web_search'], ['BashOutput', 'job_output'], ['KillShell', 'job_kill'],
  ['ToolSearch', 'nothing: there are no deferred tools here, every tool is already in your tool list'],
])

/** The reserved PTC transport; its program body bypasses per-call gating. */
export const RUN_CODE = 'run_code'

/**
 * Classify one tool call.
 * @param tool - model-visible tool name.
 * @param args - the call's arguments (`exec.arguments`).
 * @param g - session context.
 * @param outerRunCode - true when this is an outer `run_code` call (not a PTC inner call).
 */
export function classify(tool: string, args: Readonly<Record<string, unknown>>, g: GateContext, outerRunCode = false): Verdict {
  if (tool === RUN_CODE && outerRunCode) {
    return deny('run-code', 'run_code is disabled for dispatched workers because its program body is not gated; call the native tools (read/write/edit/pwsh/bash) directly')
  }
  const forbidden = FORBIDDEN_TOOLS.get(tool)
  if (forbidden !== undefined) return deny(`tool:${tool}`, forbidden)
  if (SUBAGENT_TOOLS.has(tool)) {
    return g.config?.allowSubagents === true
      ? allow('subagent-allowed')
      : deny('subagent', 'workers may not start their own subagents; the orchestrator assigns parallel work')
  }
  if (READ_TOOLS.has(tool)) return classifyRead(tool, args, g)
  if (COORDINATION_TOOLS.has(tool)) return allow('coordination')
  if (WRITE_TOOLS.has(tool)) return classifyWrite(args, g)
  if (SHELL_TOOLS.has(tool)) return classifyShell(tool, args, g)
  if (tool === 'web_search') {
    return g.config?.allowWebSearch === false ? escalate('web-search', 'web search needs approval in this deployment') : allow('web-search')
  }
  if (tool === 'web_fetch') return escalate('web-fetch', 'fetching a URL reaches the network')
  if (tool === 'working_directory') return classifyWorkingDirectory(args, g)
  if (tool.startsWith('mcp__')) return escalate('mcp-tool', `external MCP tool ${tool}`)
  const foreign = FOREIGN_TOOLS.get(tool)
  if (foreign !== undefined) {
    return deny('foreign-tool', `this harness has no tool named "${tool}" (that name belongs to another agent host). If your tool list shows this name, your route is rewriting tool names: do not retry, the task will be moved to another route. Otherwise use ${foreign} with the same arguments`)
  }
  return escalate('unknown-tool', `no rule recognizes tool "${tool}"`)
}

function stringArg(args: Readonly<Record<string, unknown>>, ...names: string[]): string | undefined {
  for (const name of names) {
    const v = args[name]
    if (typeof v === 'string' && v !== '') return v
  }
  return undefined
}

function resolveIn(g: GateContext, base: string, p: string): string {
  // The `$env:TEMP` stand-in is not a real path; it never lies inside a root.
  if (p.includes('\u0000')) return p
  const api = pathApi(g.platform)
  // `~` / `~/x` is the home directory to PowerShell providers and bash alike, never a folder named `~`.
  const absolute = /^~(?:[\\/]|$)/.test(p) ? api.resolve(g.home, `.${p.slice(1)}`) : api.isAbsolute(p) ? p : api.resolve(base, p)
  return (g.canonical ?? (q => canonicalPath(q, g.platform)))(absolute)
}

function classifyRead(tool: string, args: Readonly<Record<string, unknown>>, g: GateContext): Verdict {
  const p = stringArg(args, 'file_path', 'path')
  if (p !== undefined && isCredentialPath(resolveIn(g, g.cwd, p), g)) {
    return deny('credential-read', 'reading credential files is never allowed for workers')
  }
  return allow(`read:${tool}`)
}

/** Host tool that reports (or, given a path, moves) the session's working directory; it writes nothing. */
function classifyWorkingDirectory(args: Readonly<Record<string, unknown>>, g: GateContext): Verdict {
  const strings = Object.values(args).filter((v): v is string => typeof v === 'string' && v !== '')
  if (Object.values(args).some(v => v !== undefined && v !== null && typeof v !== 'string')) {
    return escalate('unknown-tool', 'working_directory with arguments the gate does not recognize')
  }
  for (const p of strings) {
    if (!isWithinAny(g.roots, resolveIn(g, g.cwd, p), g.platform)) {
      return escalate('workdir-outside-root', `working directory ${p} is outside the workspace roots`)
    }
  }
  return allow('working-directory')
}

function classifyWrite(args: Readonly<Record<string, unknown>>, g: GateContext): Verdict {
  const p = stringArg(args, 'file_path', 'path')
  if (p === undefined) return escalate('write-no-path', 'write without a recognizable file_path')
  const target = resolveIn(g, g.cwd, p)
  if (isCredentialPath(target, g)) return deny('credential-write', 'writing credential files is never allowed for workers')
  if (isProtectedConfig(target, g)) return deny('config-write', 'harness, Claude and Codex configuration is reserved to the orchestrator')
  if (!isWithinAny(g.roots, target, g.platform)) {
    return deny('write-outside-root', `writes are confined to the workspace roots (${g.roots.join(', ')}); ${target} is outside`)
  }
  return outsideScope(target, g) ?? allow('write-in-root')
}

// ── credentials and protected configuration ───────────────────────────────

const CREDENTIAL_SUFFIXES = [
  '.dsh/.credentials.yaml', '.ssh', '.codex/auth.json', '.claude/.credentials.json', '.aws/credentials',
  '.git-credentials', '.netrc', '.pypirc', '.npmrc', '.config/dsh-crew/.env', '.docker/config.json',
  // The orchestrator's MCP token: a worker holding it could approve its own calls.
  '.dsh/dujiangyan/token',
]

function slashLower(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

export function isCredentialPath(p: string, g: Pick<GateContext, 'home' | 'platform' | 'protectedDirs'>): boolean {
  const target = slashLower(p)
  const home = slashLower(g.home).replace(/\/+$/, '')
  for (const suffix of CREDENTIAL_SUFFIXES) {
    const full = `${home}/${suffix}`
    if (target === full || target.startsWith(`${full}/`)) return true
  }
  if ((g.protectedDirs ?? []).some(d => target === `${slashLower(d).replace(/\/+$/, '')}/token`)) return true
  const base = target.slice(target.lastIndexOf('/') + 1)
  return base === '.env' || base.startsWith('.env.') || base === 'credentials.yaml' || base === '.credentials.json'
}

/** `.dsh/dujiangyan` is the plugin data dir: the MCP token and the personal rules workers must not loosen. */
const PROTECTED_CONFIG = ['.dsh/profiles', '.dsh/dujiangyan', '.claude/settings.json', '.claude/settings.local.json', '.codex/config.toml']

function isProtectedConfig(p: string, g: Pick<GateContext, 'home' | 'protectedDirs'>): boolean {
  const target = slashLower(p)
  const home = slashLower(g.home).replace(/\/+$/, '')
  const under = (dir: string) => target === dir || target.startsWith(`${dir}/`)
  return PROTECTED_CONFIG.some(s => under(`${home}/${s}`)) || (g.protectedDirs ?? []).some(d => under(slashLower(d).replace(/\/+$/, '')))
}

// ── shell commands ─────────────────────────────────────────────────────────

/** Whole-command patterns that are always denied (lowercased, backslashes as `/`). */
const DENY_PATTERNS: ReadonlyArray<readonly [RegExp, string, string]> = [
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
]

/** curl upload flags are case-sensitive (`-f` fails fast, `-F` posts a form). */
const CURL_UPLOAD = /\bcurl(\.exe)?\b[^;|&]*\s(-T|--upload-file|-d|--data\S*|-F|--form|-X\s*(POST|PUT|PATCH|DELETE))(\s|=|$)/

const BENCH_PATTERNS = [/\bcargo\s+bench\b/, /\bbench(mark)?[\w-]*\.(py|ps1|sh)\b/, /\bcriterion\b/]

/** Whether a shell command is a benchmark (it needs bench rights; in `bench` mode it holds the machine while it runs). */
export function isBenchCommand(command: string, config?: RuleConfig): boolean {
  const normalized = command.replace(/\\/g, '/').toLowerCase()
  return [...BENCH_PATTERNS, ...(config?.benchPatterns ?? []).map(s => new RegExp(s, 'i'))].some(re => re.test(normalized))
}

/** Shell dialect of one command string: PowerShell, POSIX sh, or cmd.exe (inside `cmd /c`). */
export type Dialect = 'pwsh' | 'bash' | 'cmd'

/** Placeholder left in a segment where a nested `( … )`, `{ … }` or `$( … )` was split out. */
const SUB = '$__djy_sub'
const SUB_RE = /\$__djy_sub/g
const MAX_NESTING = 4

/** Environment variables that change which program or library a later command loads. */
const LOADER_ENV = /^(path|pathext|comspec|psmodulepath|ld_preload|ld_library_path|dyld_\w+)$/i

/** Side-effect-free .NET statics (namespace without `system.`, lowercase); `*` allows every member. */
const PURE_DOTNET = new Map<string, RegExp>([
  ...['math', 'int', 'int32', 'int64', 'uint32', 'uint64', 'double', 'decimal', 'string', 'char', 'bool', 'regex',
    'text.regularexpressions.regex', 'datetime', 'timespan', 'guid', 'convert', 'bitconverter', 'version']
    .map(t => [t, /./] as [string, RegExp]),
  ['environment', /^(processorcount|machinename|osversion|is64bitoperatingsystem|is64bitprocess|newline|tickcount|tickcount64|currentdirectory)$/],
  ['io.path', /^(combine|join|getfilename|getfilenamewithoutextension|getextension|getdirectoryname|getfullpath|changeextension|ispathrooted|getpathroot|directoryseparatorchar)$/],
  ['io.driveinfo', /^(getdrives|new)$/],
  ['io.file', /^(exists|readalltext|readalllines|readallbytes)$/],
  ['io.directory', /^(exists|getfiles|getdirectories|enumeratefiles|enumeratedirectories)$/],
  ['text.encoding', /./],
  ['text.utf8encoding', /^new$/],
  ['diagnostics.stopwatch', /^(startnew|new|gettimestamp|frequency)$/],
  ['management.automation.language.parser', /^(parsefile|parseinput)$/],
  // Physical memory size; the read-only way to get it inside the sandbox (WMI is refused there).
  ['microsoft.visualbasic.devices.computerinfo', /^(new|totalphysicalmemory|availablephysicalmemory)$/],
])

/** Commands that read, build or run workspace code — writes are still confined by the OS sandbox. */
const ALLOW_COMMANDS = new Set([
  'cargo', 'rustc', 'rustfmt', 'rustup', 'python', 'python3', 'py', 'node', 'cmake', 'ninja', 'make', 'nmake', 'msbuild',
  'nvidia-smi',
  // read-only / informational
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'sort', 'uniq', 'find', 'findstr', 'grep', 'rg', 'where', 'which',
  'echo', 'exit', 'pwd', 'cd', 'pushd', 'popd', 'hostname', 'whoami', 'systeminfo', 'tasklist', 'ps', 'du', 'df', 'tree', 'file',
  'date', 'time', 'sleep', 'wait-process', 'true', 'false', 'test', 'diff', 'fc', 'certutil', 'sha256sum', 'md5sum', 'nproc', 'uname',
  // workspace file mutation (targets are checked separately)
  'mkdir', 'md', 'touch', 'cp', 'copy', 'xcopy', 'robocopy', 'mv', 'move', 'ren', 'rename', 'tee', 'rm', 'del', 'erase', 'rd', 'rmdir', 'chmod',
  'tar', 'unzip', 'zip', '7z', 'gzip', 'gunzip', 'zstd',
])
const READ_CMDLET = /^(get|test|resolve|split|join|select|sort|where|foreach|format|out-string|out-null|measure|compare|group|convertto|convertfrom|write-output|write-host|write-verbose|write-information|write-progress|start-sleep|new-timespan|import-csv|export-csv|tee-object|out-file|set-content|add-content|new-item|copy-item|move-item|rename-item|remove-item|set-location|push-location|pop-location|clear-content|expand-archive|compress-archive)(-|$)/
const WRITE_COMMANDS = new Set([
  'mkdir', 'md', 'touch', 'cp', 'copy', 'xcopy', 'robocopy', 'mv', 'move', 'ren', 'rename', 'tee', 'rm', 'del', 'erase', 'rd', 'rmdir', 'chmod',
  'tee-object', 'out-file', 'set-content', 'add-content', 'new-item', 'copy-item', 'move-item', 'rename-item', 'remove-item', 'clear-content',
  'export-csv', 'expand-archive', 'compress-archive',
])
/** Cmdlets that write one file: positional arguments after the path are the data (`-Value`, `-Encoding`). */
const SINGLE_PATH_COMMANDS = new Set(['set-content', 'add-content', 'out-file', 'tee-object'])
const DELETE_COMMANDS = new Set(['rm', 'del', 'erase', 'rd', 'rmdir', 'remove-item', 'clear-content'])
const GIT_LOCAL = new Set(['status', 'diff', 'log', 'show', 'add', 'commit', 'branch', 'checkout', 'switch', 'restore', 'stash', 'init', 'rev-parse', 'ls-files', 'blame', 'tag', 'worktree', 'mv', 'rm', 'describe', 'shortlog', 'reflog', 'cat-file', 'config',
  // read-only plumbing / inspection
  'rev-list', 'ls-tree', 'show-ref', 'for-each-ref', 'name-rev', 'merge-base', 'count-objects', 'grep', 'verify-pack', 'cherry', 'whatchanged'])
const GIT_NETWORK = new Set(['clone', 'fetch', 'pull', 'submodule', 'lfs', 'ls-remote'])
const CONTROL_WORDS = new Set(['foreach', 'for', 'if', 'elseif', 'else', 'try', 'catch', 'finally', 'while', 'do', 'switch', 'function', 'param', 'return', 'break', 'continue', 'begin', 'process', 'end', 'then', 'fi', 'done', 'esac', 'in', 'throw', 'trap'])
const PATH_PARAMS = new Set(['-path', '-literalpath', '-filepath', '-destination', '-outfile', '-outputpath', '-target'])
/** Parameters whose value is data, not a write target. */
const VALUE_PARAMS = new Set(['-value', '-encoding', '-itemtype', '-filter', '-include', '-exclude', '-delimiter', '-erroraction', '-pattern'])
/** PowerShell host options that take a value (`pwsh -ExecutionPolicy Bypass -File x.ps1`). */
const PWSH_VALUE_OPTIONS = new Set(['-executionpolicy', '-ep', '-ex', '-workingdirectory', '-wd', '-outputformat', '-of', '-inputformat', '-if', '-windowstyle', '-w', '-configurationname', '-settingsfile'])
const ESCAPE: Readonly<Record<Dialect, string>> = { pwsh: '`', bash: '\\', cmd: '^' }

/**
 * `set NAME=value` inside `cmd /c "…"`: sets a variable of that cmd process for the programs it runs
 * next, like a bash environment prefix (S17 overnight, 39 approvals). Loader variables follow
 * `allowEnv`; `set /a` and `set /p` (arithmetic, a prompt reading stdin) still need an approver.
 */
function classifyCmdSet(rest: readonly string[], g: GateContext, vars: Vars): Verdict {
  const args = rest.filter(t => !/^\d?>/.test(t))
  if (args.length === 0) return checkRedirects(rest, g, 'cmd-set', vars, 'cmd') // lists the variables
  if (args[0]?.startsWith('/')) return escalate('unknown-command', `cmd set ${args[0]} needs an approver`)
  const m = /^([A-Za-z_][\w.]*)=([\s\S]*)$/.exec(unquote(args.join(' '), 'cmd'))
  if (m === null) return checkRedirects(rest, g, 'cmd-set', vars, 'cmd') // `set PREFIX` lists matching variables
  const key = m[1] as string
  if (LOADER_ENV.test(key) && !allowedEnv(key.toLowerCase(), m[2] as string, g, vars, 'cmd')) {
    return escalate('env-loader', `setting ${key} changes which programs or libraries later commands load`)
  }
  return checkRedirects(rest, g, 'cmd-set', vars, 'cmd')
}

/** A `sandbox_permissions` request for exactly the mode the call already has; fails closed when the mode is unknown. */
export function sandboxNoop(args: Readonly<Record<string, unknown>>, g: GateContext): boolean {
  const requested = args['sandbox_permissions']
  return typeof requested === 'string' && g.sandboxMode !== undefined && g.sandboxMode !== '' && requested.trim() === g.sandboxMode
}

function classifyShell(tool: string, args: Readonly<Record<string, unknown>>, g: GateContext): Verdict {
  if (args['sandbox_permissions'] !== undefined && !sandboxNoop(args, g)) {
    return escalate('sandbox-escalation', `the call asks to widen its sandbox (${String(args['sandbox_permissions'])}): ${String(args['justification'] ?? '')}`)
  }
  const command = stringArg(args, 'command')
  if (command === undefined) return escalate('shell-empty', `${tool} call without a command`)
  let cwd = g.cwd
  const workdir = stringArg(args, 'workdir')
  if (workdir !== undefined) {
    cwd = resolveIn(g, g.cwd, workdir)
    if (!isWithinAny(g.roots, cwd, g.platform)) return escalate('workdir-outside-root', `working directory ${cwd} is outside the workspace roots`)
  }
  return classifyCommand(command, { ...g, cwd }, tool === 'bash' ? 'bash' : 'pwsh')
}

/** Literal assignments seen so far in one command line (`$p = 'x'`), so `& $p` and `Set-Content $p` resolve. */
type Vars = Map<string, string>

/**
 * What a whole command line tells about its segments: functions it defines (or dot-sources from a
 * workspace script), and whether it waits for the processes it starts.
 */
interface CommandInfo {
  readonly functions: Set<string>
  /** The command without string contents and comments: the text that runs. */
  readonly code: string
  /** The variable the current segment assigns to (`$p = Start-Process …`), if any. */
  assigned?: string
}

/**
 * Stand-in value for `$env:TEMP` / `$env:TMP`: inside the sandbox they point to the worker's own
 * temp directory (findings 44). A NUL can never appear in a real command, so no literal text can
 * pose as it; `judgeTarget` treats a path under it as scratch.
 */
const SCRATCH = '\u0000scratch'

/**
 * Keys beside a variable's literal value in `Vars`: `MULTI + name` holds the values a `foreach`
 * loop variable takes (JSON array; the plain key holds the first), `LIST + name` an array value
 * (`$a = 'x','y'`). Both start with control characters no variable name can contain.
 */
const MULTI = '\u0001'
const LIST = '\u0002'
const MAX_COMBINATIONS = 16

/** The items of a literal list: `'a','b'`, `1,20`, `@('a', "b")`, or a list variable. */
function literalList(tokens: readonly string[], vars: Vars, dialect: Dialect): string[] | undefined {
  if (tokens.length === 0) return undefined
  let text = tokens.join('')
  if (tokens.length === 1) {
    const ref = /^\$(\w+)$/.exec(text)
    if (ref !== null) {
      const list = vars.get(LIST + (ref[1] as string).toLowerCase())
      return list === undefined ? undefined : JSON.parse(list) as string[]
    }
  }
  const inner = /^@\(([\s\S]*)\)$/.exec(text)
  if (inner !== null) text = inner[1] as string
  else if (!text.includes(',')) return undefined
  const items = splitTopLevelCommas(text).map(x => literalValue(x.trim(), vars, dialect))
  return items.every((x): x is string => x !== undefined) ? items : undefined
}

/** Variables a token refers to (`$name`, `${name}`), lowercased. */
function referencedVars(token: string): string[] {
  return [...token.matchAll(/\$\{?([A-Za-z_]\w*)\}?/g)].map(m => (m[1] as string).toLowerCase())
}

/** A literal starting point for the variables of one command line. */
function initialVars(g: GateContext, dialect: Dialect): Vars {
  const vars: Vars = new Map()
  if (dialect === 'pwsh') {
    vars.set('env:temp', SCRATCH)
    vars.set('env:tmp', SCRATCH)
    vars.set('pwd', g.cwd)
  }
  return vars
}

/** The command text with string contents and comments blanked, so text that only mentions code does not count as code. */
function codeOnly(command: string): string {
  return command.replace(/<#[\s\S]*?#>|@'[\s\S]*?'@|@"[\s\S]*?"@|'(?:[^']|'')*'|"(?:[^"`]|`[\s\S])*"|(^|\s)#[^\r\n]*/g, (_m, lead: string | undefined) => lead ?? "''")
}

/** Commands that change the current directory of the shell running the command line. */
const CD_COMMANDS = new Set(['cd', 'chdir', 'sl', 'set-location', 'pushd', 'push-location', 'popd', 'pop-location'])
const MAX_CWDS = 4

/**
 * Where a `cd`-like segment may leave the shell: `undefined` when the target cannot be resolved,
 * otherwise the directories it may lead to from each possible current one (none for popd / `cd -`,
 * whose targets are among the directories already possible).
 */
function cdTargets(tokens: readonly string[], g: GateContext, cwds: readonly string[], vars: Vars, dialect: Dialect): string[] | undefined {
  const name = commandName(tokens[0] as string)
  if (name === 'popd' || name === 'pop-location') return []
  const args: string[] = []
  for (let k = 1; k < tokens.length; k++) {
    const t = tokens[k] as string
    if (/^-(path|literalpath|p|l|e|@)$/i.test(t) || /^-passthru$/i.test(t)) continue
    if (/^-\w/.test(t)) return undefined // -StackName and the like: not worth modelling
    args.push(t)
  }
  if (args.length > 1) return undefined
  if (args[0] === '-' || args[0] === '+') return []
  const value = args[0] === undefined ? '~' : literalValue(args[0], vars, dialect)
  if (value === undefined || /[$*?`%\u0000]/.test(value) || /^~[^\\/]/.test(value)) return undefined
  return cwds.map(c => resolveIn(g, c, value))
}

/** Classify a full shell command line (bash or PowerShell dialect). */
export function classifyCommand(command: string, g: GateContext, dialect: Dialect = g.platform === 'win32' ? 'pwsh' : 'bash', depth = 0, outerVars?: ReadonlyMap<string, string>): Verdict {
  if (depth > MAX_NESTING) return escalate('nesting', 'the command nests shells too deeply to inspect')
  // These control characters are the gate's own markers (SCRATCH, MULTI, LIST, HASH_ENTRY); no real command has them.
  if (/[\u0000-\u0003]/.test(command)) return escalate('unknown-command', 'the command contains control characters')
  const normalized = command.replace(/\\/g, '/').toLowerCase()
  for (const [re, rule, reason] of DENY_PATTERNS) {
    if (re.test(normalized)) return deny(rule, reason)
  }
  if (CURL_UPLOAD.test(command)) return deny('upload', 'sending data with curl is not allowed')
  for (const source of g.config?.denyPatterns ?? []) {
    if (new RegExp(source, 'i').test(command)) return deny('custom-deny', `matches deny pattern /${source}/`)
  }
  const bench = [...BENCH_PATTERNS, ...(g.config?.benchPatterns ?? []).map(s => new RegExp(s, 'i'))]
  if (!g.holdsBench && bench.some(re => re.test(normalized))) {
    return deny('bench-lease', 'benchmark commands need the exclusive "bench" lease; submit this step as a task with resources ["bench"] (or wait for the current holder) instead of running it now')
  }

  const vars: Vars = new Map([...initialVars(g, dialect), ...outerVars ?? []])
  const info: CommandInfo = { functions: new Set(), code: codeOnly(command) }
  let worst: Verdict = allow('shell-allowlist')
  const note = (verdict: Verdict) => {
    if (verdict.kind === 'escalate' && worst.kind === 'allow') worst = verdict
  }
  // Every directory the shell may be in at this point; a `cd` adds its target (a conditional one
  // may not have happened), so relative paths are judged from each of them.
  let cwds = [g.cwd]
  const meta: SegmentMeta[] = []
  const segments = splitSegments(command, dialect, meta)
  for (const [k, segment] of segments.entries()) {
    const tokens = tokenizeRaw(segment, dialect)
    if (dialect === 'pwsh') {
      vars.set('pwd', cwds[0] as string)
      if (cwds.length > 1) vars.set(`${MULTI}pwd`, JSON.stringify(cwds))
      else vars.delete(`${MULTI}pwd`)
    }
    for (const cwd of cwds) {
      const verdict = classifySegment([...tokens], cwd === g.cwd ? g : { ...g, cwd }, dialect, vars, depth, info)
      if (verdict.kind === 'deny') return verdict
      note(verdict)
    }
    if (tokens[0] !== undefined && CD_COMMANDS.has(commandName(tokens[0]))) {
      const next = cdTargets(tokens, g, cwds, vars, dialect)
      // A `cd` that surely runs, into directories that exist, leaves the shell only there; a
      // conditional or possibly failing one (the shell then stays put) keeps the old ones too.
      const sure = next !== undefined && next.length > 0 && meta[k]?.conditional === false && next.every(d => g.isDirectory?.(pathApi(g.platform).normalize(d)) === true)
      const merged = next === undefined ? undefined : [...new Set(sure ? next : [...cwds, ...next])]
      if (merged === undefined || merged.length > MAX_CWDS) {
        // Later relative paths could point anywhere; the call itself still gets judged for denials.
        note(escalate('dynamic-target', 'the command changes to a directory the gate cannot resolve statically'))
      } else {
        cwds = merged
      }
    }
  }
  return worst
}

interface Frame { readonly buf: string; readonly close: string | undefined; readonly quote: string | undefined; readonly hash: boolean; readonly conditional: boolean }

/** Where a segment sits: inside a block or after `&&` / `||` it may not run. */
export interface SegmentMeta { readonly conditional: boolean }

/** First token of a segment that is an entry of a `@{ … }` hashtable literal (`key = value`), not a command. */
export const HASH_ENTRY = '\u0003'

/**
 * The body of `@( … )` when it is only plain literals: quoted strings without subexpressions, and
 * numbers. A bare word is not a literal there — `@(Remove-Item x)` runs a command.
 */
const LITERAL_ITEM = String.raw`(?:'[^']*'|"[^"$` + '`' + String.raw`]*(?:\$\{?[A-Za-z_]\w*\}?[^"$` + '`' + String.raw`]*)*"|-?\d[\d.]*)`
const RESOLVE_PATH = /^\(\s*Resolve-Path\s+(?:-(?:Literal)?Path\s+)?('[^']*'|"[^"$`]*"|[\w.:/\\-]+)\s*\)\.Path\b/i
const LITERAL_LIST = new RegExp(String.raw`^\s*(?:${LITERAL_ITEM}(?:\s*,\s*${LITERAL_ITEM})*)?\s*$`)

/**
 * Split a command into simple commands: on unquoted `;`, `&&`, `||`, `|` and newlines (and `&` in
 * cmd), and around every nested `( … )`, `{ … }` and `$( … )` — also inside double quotes — and bash
 * backticks. A nested body becomes its own segment(s) and is classified like any other command; the
 * enclosing segment keeps a placeholder, so `Remove-Item (Join-Path a b)` still has an unresolvable
 * target. Quotes, escapes and here-strings (`@'…'@`) stay intact inside a segment.
 */
export function splitSegments(command: string, dialect: Dialect = 'pwsh', meta?: SegmentMeta[]): string[] {
  const out: string[] = []
  const esc = ESCAPE[dialect]
  const frames: Frame[] = []
  let buf = ''
  let close: string | undefined
  let quote: string | undefined
  let hash = false
  let conditional = false
  const flush = () => {
    if (buf.trim() !== '') {
      out.push(hash ? `${HASH_ENTRY} ${buf.trim()}` : buf.trim())
      meta?.push({ conditional: conditional || frames.length > 0 })
    }
    buf = ''
    conditional = false
  }
  const open = (closer: string, outerQuote: string | undefined, isHash = false) => {
    buf += SUB
    frames.push({ buf, close, quote: outerQuote, hash, conditional })
    buf = ''
    conditional = false
    close = closer
    quote = undefined
    hash = isHash
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string
    const next = command[i + 1]
    if (quote !== undefined) {
      const literal = quote === '\'' || quote === '@\''
      if (!literal && c === esc && next !== undefined) {
        buf += c + next
        i++
        continue
      }
      if (quote.length === 2) {
        if (c === '\n' && command.startsWith(`${quote[1] as string}@`, i + 1)) {
          buf += `${c}${quote[1] as string}@`
          i += 2
          quote = undefined
          continue
        }
      } else if (c === quote) {
        buf += c
        quote = undefined
        continue
      }
      if (!literal && c === '$' && next === '(') {
        i++
        open(')', quote)
        continue
      }
      if (!literal && dialect === 'bash' && c === '`') {
        open('`', quote)
        continue
      }
      buf += c
      continue
    }
    if (close !== undefined && c === close) {
      flush()
      const frame = frames.pop() as Frame
      buf = frame.buf
      close = frame.close
      quote = frame.quote
      hash = frame.hash
      conditional = frame.conditional
      continue
    }
    if (c === esc && next !== undefined) {
      buf += c + next
      i++
      continue
    }
    // Comments never run: `# …` to the end of the line where a token starts, and PowerShell `<# … #>`.
    if (dialect !== 'cmd' && (buf === '' || /\s$/.test(buf))) {
      if (c === '#') {
        const end = command.slice(i).search(/[\r\n]/)
        if (end < 0) break
        i += end - 1
        continue
      }
      if (dialect === 'pwsh' && c === '<' && next === '#') {
        const end = command.indexOf('#>', i + 2)
        if (end < 0) break
        i = end + 1
        buf += ' '
        continue
      }
    }
    if (c === '@' && (next === '"' || next === '\'') && /^\r?\n/.test(command.slice(i + 2))) {
      quote = `@${next}`
      buf += c + next
      i++
      continue
    }
    if (c === '"' || (c === '\'' && dialect !== 'cmd')) {
      quote = c
      buf += c
      continue
    }
    if (c === '$' && next === '{') {
      const end = command.indexOf('}', i)
      if (end > i) {
        buf += command.slice(i, end + 1)
        i = end
        continue
      }
    }
    // `@('a', "b", 1)`: a list of plain literals stays inline (compacted), so `foreach ($x in @(…))`
    // and `-ArgumentList @(…)` can be read; anything else in `@( … )` is split out like `( … )`.
    if (dialect === 'pwsh' && c === '@' && next === '(') {
      const end = command.indexOf(')', i + 2)
      const body = end > i ? command.slice(i + 2, end) : undefined
      if (body !== undefined && LITERAL_LIST.test(body)) {
        buf += `@(${splitTopLevelCommas(body).map(x => x.trim()).join(',')})`
        i = end
        continue
      }
    }
    // `(Resolve-Path <literal>).Path` is that literal path resolved against the working directory.
    const resolved = dialect === 'pwsh' && c === '(' ? RESOLVE_PATH.exec(command.slice(i)) : null
    if (resolved !== null) {
      const p = resolved[1] as string
      buf += /^['"]/.test(p) ? p : `'${p}'`
      i += resolved[0].length - 1
      continue
    }
    if (c === '(' || c === '{') {
      open(c === '(' ? ')' : '}', undefined, dialect === 'pwsh' && c === '{' && buf.endsWith('@'))
      continue
    }
    if (dialect === 'bash' && c === '`') {
      open('`', undefined)
      continue
    }
    if (c === ';' || c === '\n' || c === '\r' || c === '|' || (c === '&' && (next === '&' || dialect === 'cmd') && !buf.endsWith('>'))) {
      const chained = (c === '&' && next === '&') || (c === '|' && next === '|')
      if (chained) i++
      flush()
      conditional = chained // the next segment runs only if this one succeeded (or failed)
      continue
    }
    buf += c
  }
  flush()
  while (frames.length > 0) {
    const frame = frames.pop() as Frame
    buf = frame.buf
    hash = frame.hash
    conditional = true
    flush()
  }
  return out
}

/** Whitespace tokenizer honoring quotes, escapes and here-strings; quotes are kept on the tokens. */
function tokenizeRaw(segment: string, dialect: Dialect): string[] {
  const out: string[] = []
  const esc = ESCAPE[dialect]
  let current = ''
  let quote: string | undefined
  let started = false
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i] as string
    const next = segment[i + 1]
    if (quote !== undefined) {
      current += c
      const literal = quote === '\'' || quote === '@\''
      if (!literal && c === esc && next !== undefined) {
        current += next
        i++
      } else if (quote.length === 2 ? c === '\n' && segment.startsWith(`${quote[1] as string}@`, i + 1) : c === quote) {
        if (quote.length === 2) {
          current += `${quote[1] as string}@`
          i += 2
        }
        quote = undefined
      }
      continue
    }
    if (c === '@' && (next === '"' || next === '\'') && /^\r?\n/.test(segment.slice(i + 2))) {
      quote = `@${next}`
      current += c + next
      started = true
      i++
      continue
    }
    if (c === '"' || (c === '\'' && dialect !== 'cmd')) {
      quote = c
      current += c
      started = true
      continue
    }
    if (c === esc && next !== undefined) {
      current += c + next
      i++
      continue
    }
    if (/\s/.test(c)) {
      if (started || current !== '') out.push(current)
      current = ''
      started = false
      continue
    }
    current += c
  }
  if (started || current !== '') out.push(current)
  return out
}

/** Remove quoting and escapes from one raw token. */
function unquote(raw: string, dialect: Dialect): string {
  const here = /^@(["'])\r?\n([\s\S]*?)\r?\n\1@$/.exec(raw)
  if (here !== null) return here[2] as string
  const esc = ESCAPE[dialect]
  let out = ''
  let quote: string | undefined
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as string
    if (quote !== undefined) {
      if (c === quote) quote = undefined
      else if (quote === '"' && c === esc && i + 1 < raw.length) out += raw[++i] as string
      else out += c
      continue
    }
    if (c === '"' || (c === '\'' && dialect !== 'cmd')) quote = c
    else if (c === esc && i + 1 < raw.length) out += raw[++i] as string
    else out += c
  }
  return out
}

/** Whitespace tokenizer honoring single and double quotes (quotes removed). */
export function tokenize(segment: string, dialect: Dialect = 'pwsh'): string[] {
  return tokenizeRaw(segment, dialect).map(t => unquote(t, dialect))
}

/**
 * The value of a token when it is fully known before the command runs: a quoted or bare literal,
 * with `$name` expanded only from earlier literal assignments. Anything computed at run time
 * (subexpressions, unknown variables, escapes) yields undefined.
 */
function literalValue(raw: string, vars: ReadonlyMap<string, string>, dialect: Dialect): string | undefined {
  if (raw.includes(SUB)) return undefined
  if (/^'[^']*'$/.test(raw) || raw.startsWith('@\'')) return unquote(raw, dialect)
  const body = /^"([^"]*)"$/.exec(raw)?.[1] ?? (/^[^"'`\s]+$/.test(raw) ? raw : undefined)
  if (body === undefined || body.includes(ESCAPE[dialect])) return undefined
  let unresolved = false
  const value = body.replace(/\$\{?([A-Za-z_][\w:]*)\}?/g, (_, name: string) => {
    const v = vars.get(name.toLowerCase())
    if (v === undefined) unresolved = true
    return v ?? ''
  })
  return unresolved ? undefined : value
}

/** Split a raw token on commas outside quotes (`"a","b"` → two targets). */
function splitTopLevelCommas(raw: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | undefined
  for (const c of raw) {
    if (quote !== undefined) {
      if (c === quote) quote = undefined
    } else if (c === '"' || c === '\'') {
      quote = c
    } else if (c === ',') {
      out.push(current)
      current = ''
      continue
    }
    current += c
  }
  out.push(current)
  return out.filter(p => p !== '')
}

/**
 * Built-in PowerShell aliases, normalized to the cmdlet they stand for so the same rules apply:
 * read aliases stop escalating as unknown commands, and write aliases get the write-target checks
 * of their cmdlet. `sc` is left out on purpose (Set-Content in 5.1, but sc.exe service control elsewhere).
 */
const PS_ALIASES: Readonly<Record<string, string>> = {
  '?': 'where-object', '%': 'foreach-object', where: 'where-object', foreach: 'foreach-object',
  gci: 'get-childitem', gc: 'get-content', gi: 'get-item', gp: 'get-itemproperty', gl: 'get-location', gm: 'get-member',
  ft: 'format-table', fl: 'format-list', fw: 'format-wide', select: 'select-object', sls: 'select-string',
  measure: 'measure-object', group: 'group-object', compare: 'compare-object', diff: 'compare-object',
  write: 'write-output', sleep: 'start-sleep',
  ac: 'add-content', ni: 'new-item', ri: 'remove-item', cpi: 'copy-item', mi: 'move-item', rni: 'rename-item', clc: 'clear-content',
}

function commandName(token: string): string {
  const base = token.replace(/\\/g, '/').split('/').pop() ?? token
  let name = base.toLowerCase().replace(/\.(exe|cmd|bat|ps1|com)$/, '')
  // A script block glued to its cmdlet (`?{..}`, `%{..}`, `Where-Object{..}`) arrives as name + body
  // placeholder; the body is judged as its own segment, so the command is the name alone.
  const unglued = name.replace(SUB_RE, '')
  if (unglued !== name && /^[\w?%-]+$/.test(unglued)) name = unglued
  return PS_ALIASES[name] ?? name
}

/**
 * `[Console]::OutputEncoding = [Text.Encoding]::UTF8` (or InputEncoding) only changes this console's text
 * encoding. The right-hand side must itself be a plain encoding value, or a hidden .NET call could ride on it.
 */
function isConsoleEncoding(type: string, member: string, head: string, rest: readonly string[]): boolean {
  if (!/^(system\.)?console$/i.test(type) || !/^(output|input)encoding$/i.test(member)) return false
  const inline = /^\[[\w.]+\]::\w+=(.*)$/.exec(head)
  const value = inline !== null ? [inline[1] as string, ...rest].join(' ') : rest[0] === '=' ? rest.slice(1).join(' ') : undefined
  if (value === undefined) return false
  // A parenthesized argument arrives as the nested-body placeholder; that body is classified as its own segment.
  return /^\s*\[(system\.)?text\.(encoding|utf8encoding)\]::\w+(\$__djy_sub)?\s*$/i.test(value)
}

/** Data types whose constructor runs no code of the caller's choosing (`New-Object`). */
const PURE_NEW_TYPES = /^(system\.)?(collections\.(generic\.)?(list|hashset|dictionary|queue|stack|sortedset|sorteddictionary)|collections\.arraylist|collections\.hashtable|text\.stringbuilder)$/i

function isPureDotnet(type: string, member: string): boolean {
  const t = type.toLowerCase().replace(/^system\./, '')
  return PURE_DOTNET.get(t)?.test(member.toLowerCase()) === true
}

const GLUED_CONTROL = /^(?:if|elseif|else|foreach|for|while|switch|do|until|try|catch|finally|default)+$/

const dynamicCommand = (): Verdict => escalate('dynamic-command', 'the command name or script path is computed at run time (variable, subexpression or concatenation); call the program by its literal name or path')

function classifySegment(raw: string[], g: GateContext, dialect: Dialect, vars: Vars, depth: number, info: CommandInfo): Verdict {
  // A segment that uses a `foreach` loop variable is judged once per value it takes.
  const loops = [...new Set(raw.flatMap(referencedVars))].filter(n => vars.has(MULTI + n))
  if (loops.length > 0) return classifyPerValue(raw, loops, g, dialect, vars, depth, info)
  // `foreach ($x in <literal list>)` header: $x takes each listed value in the body.
  if (dialect === 'pwsh' && /^\$\w+$/.test(raw[0] ?? '') && raw[1]?.toLowerCase() === 'in') {
    const name = (raw[0] as string).slice(1).toLowerCase()
    const items = literalList(raw.slice(2), vars, dialect)
    vars.delete(MULTI + name)
    vars.delete(LIST + name)
    if (items === undefined || items.length === 0 || items.length > MAX_COMBINATIONS) vars.delete(name)
    else {
      vars.set(name, items[0] as string)
      if (items.length > 1) vars.set(MULTI + name, JSON.stringify(items))
    }
    return allow('foreach-header')
  }
  return classifySimple(raw, g, dialect, vars, depth, info)
}

/**
 * Judge a segment for every combination of its loop variables' values (at most MAX_COMBINATIONS);
 * the worst verdict wins. Variables assigned in it keep every value they took.
 */
function classifyPerValue(raw: readonly string[], loops: readonly string[], g: GateContext, dialect: Dialect, vars: Vars, depth: number, info: CommandInfo): Verdict {
  let combos: Array<Map<string, string>> = [new Map()]
  for (const name of loops) {
    const values = JSON.parse(vars.get(MULTI + name) as string) as string[]
    combos = combos.flatMap(c => values.map(v => new Map([...c, [name, v]])))
    if (combos.length > MAX_COMBINATIONS) return escalate('dynamic-target', 'too many loop-value combinations to check statically')
  }
  let worst: Verdict = allow('shell-allowlist')
  const clones: Vars[] = []
  for (const combo of combos) {
    const scoped: Vars = new Map(vars)
    for (const [name, v] of combo) {
      scoped.set(name, v)
      scoped.delete(MULTI + name)
    }
    const v = classifySimple([...raw], g, dialect, scoped, depth, info)
    if (v.kind === 'deny') return v
    if (v.kind === 'escalate' && worst.kind === 'allow') worst = v
    clones.push(scoped)
  }
  const keys = new Set(clones.flatMap(c => [...c.keys()]).filter(k => !k.startsWith(MULTI) && !k.startsWith(LIST) && !loops.includes(k)))
  for (const key of keys) {
    const values = clones.map(c => c.get(key))
    const distinct = [...new Set(values)]
    vars.delete(MULTI + key)
    if (values.some(v => v === undefined)) vars.delete(key)
    else {
      vars.set(key, distinct[0] as string)
      if (distinct.length > 1) vars.set(MULTI + key, JSON.stringify(distinct))
    }
  }
  return worst
}

function classifySimple(raw: string[], g: GateContext, dialect: Dialect, vars: Vars, depth: number, info: CommandInfo): Verdict {
  // A hashtable entry `key = value`: only the value runs (it can be a pipeline, so it is judged).
  if (raw[0] === HASH_ENTRY) {
    const glued = /^(?:[\w-]+|'[^']*'|"[^"]*")=([\s\S]*)$/.exec(raw[1] ?? '')
    if (glued !== null) return classifySimple([...glued[1] !== '' ? [glued[1] as string] : [], ...raw.slice(2)], g, dialect, vars, depth, info)
    if (raw[2] === '=' && /^(?:[\w-]+|'[^']*'|"[^"]*")$/.test(raw[1] ?? '')) return classifySimple(raw.slice(3), g, dialect, vars, depth, info)
    return classifySimple(raw.slice(1), g, dialect, vars, depth, info)
  }
  // Drop call operators, control-flow words, braces and assignments (remembering literal ones).
  info.assigned = undefined
  let i = 0
  let called = false
  let dotSourced = false
  for (;;) {
    const t = raw[i]
    if (t === undefined) return allow('shell-neutral')
    if (t === '&' || t === '.') {
      called = true
      dotSourced = t === '.'
      i++
      continue
    }
    const bare = t.replace(SUB_RE, '').replace(/[{}()]/g, '').toLowerCase()
    // `function Name { … }`: the body is judged as its own segments; later calls to Name run that body.
    if (!called && dialect === 'pwsh' && (bare === 'function' || bare === 'filter')) {
      const fname = /^[\w-]+/.exec((raw[i + 1] ?? '').replace(SUB_RE, ' '))?.[0]
      if (fname !== undefined) {
        info.functions.add(fname.toLowerCase())
        return allow('function-def')
      }
    }
    // `if(..){..}else{..}` leaves its keywords glued around the body placeholders ("ifelse" once
    // stripped); the bodies themselves are judged as their own segments.
    if (t === '!' || /^[{}()]+$/.test(t) || (!called && bare !== '' && (CONTROL_WORDS.has(bare) || GLUED_CONTROL.test(bare)))) {
      i++
      continue
    }
    let name: string | undefined
    let rhs: string[] = []
    let appending = false
    if (/^\$[\w:]+$/.test(t) && (raw[i + 1] === '=' || raw[i + 1] === '+=')) {
      name = t.slice(1)
      appending = raw[i + 1] === '+='
      rhs = raw.slice(i + 2)
      i += 2
    } else {
      const m = /^\$([\w:]+)\+?=([\s\S]*)$/.exec(t)
      if (m !== null) {
        name = m[1] as string
        appending = /^\$[\w:]+\+=/.test(t)
        const value = m[2] as string
        rhs = value === '' ? raw.slice(i + 1) : [value, ...raw.slice(i + 1)]
        if (value === '') i++
        else raw[i] = value
      }
    }
    if (name !== undefined) {
      const lower = name.toLowerCase()
      info.assigned = lower
      if (lower.startsWith('env:') && LOADER_ENV.test(lower.slice(4))) {
        if (appending || rhs.length !== 1 || !allowedEnv(lower.slice(4), rhs[0] as string, g, vars, dialect)) {
          return escalate('env-loader', `setting $${name} changes which programs or libraries later commands load`)
        }
        vars.delete(lower)
        continue
      }
      // `$p += 'x'` extends the old value: whatever it was, it is no longer a known literal.
      const list = appending || dialect !== 'pwsh' ? undefined : literalList(rhs, vars, dialect)
      const value = appending || list !== undefined ? undefined : rhs.length === 1 ? literalValue(rhs[0] as string, vars, dialect) : joinPathValue(rhs, vars, dialect)
      vars.delete(MULTI + lower)
      if (list !== undefined) vars.set(LIST + lower, JSON.stringify(list))
      else vars.delete(LIST + lower)
      if (value === undefined) vars.delete(lower)
      else vars.set(lower, value)
      continue
    }
    // `NAME=value`: a bash environment prefix, or an entry of a PowerShell hashtable literal.
    const prefix = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(t)
    if (prefix !== null && !called) {
      const key = prefix[1] as string
      if (dialect === 'bash') {
        if (LOADER_ENV.test(key) && !allowedEnv(key.toLowerCase(), prefix[2] as string, g, vars, dialect)) return escalate('env-loader', `setting ${key} changes which programs or libraries later commands load`)
        const value = literalValue(prefix[2] as string, vars, dialect)
        if (value === undefined) vars.delete(key.toLowerCase())
        else vars.set(key.toLowerCase(), value)
      }
      i++
      continue
    }
    break
  }

  let head = raw[i] as string
  const rest = raw.slice(i + 1)
  if (called || dialect !== 'pwsh') {
    // `& $tool`, `& "path"`, or a bash/cmd command word: only literal names can be judged.
    if (!called && head === SUB) return allow('shell-group') // a `( … )` / `{ … }` body, classified on its own
    const value = literalValue(head, vars, dialect)
    if (value === undefined) return dynamicCommand()
    head = value
  } else {
    const dotnet = /^\[([\w.]+)\]::(\w+)/.exec(head)
    if (dotnet !== null && isConsoleEncoding(dotnet[1] as string, dotnet[2] as string, head, rest)) return allow('console-encoding')
    if (dotnet !== null) {
      return isPureDotnet(dotnet[1] as string, dotnet[2] as string)
        ? allow('dotnet-pure')
        : escalate('dotnet-call', `direct .NET call ${head.replace(SUB_RE, '(…)').slice(0, 80)}`)
    }
    // A PowerShell value expression (string, number, variable, array, member access, operator), not a command.
    if (/^["'@$\d([\-+*/%,=<>!]|^\.[A-Za-z_]/.test(head)) return allow('shell-expression')
  }
  const name = commandName(head)
  const args = rest.map(t => unquote(t, dialect))

  // A function this command defined (or dot-sourced from a workspace script): its body was judged.
  if (info.functions.has(name) && !/[\\/]/.test(head)) {
    return shadowsCommand(name, g)
      ? escalate('shadowed-command', `"${name}" is redefined as a function here; a reader (and the gate) would take it for the built-in command`)
      : checkRedirects(rest, g, 'local-function', vars, dialect)
  }
  if (name === 'git') return classifyGit(args, g)
  if (name === 'curl' || name === 'wget' || name === 'invoke-webrequest' || name === 'invoke-restmethod' || name === 'iwr' || name === 'irm') {
    return escalate('network-read', `${name} reaches the network`)
  }
  if (name === 'cmd') {
    const k = args.findIndex(t => /^\/[ck]$/i.test(t))
    return k < 0 ? escalate('unknown-command', 'cmd without /c starts an interactive shell') : classifyNested(rest.slice(k + 1), dialect, 'cmd', g, depth, vars)
  }
  if (dialect === 'cmd' && name === 'set') return classifyCmdSet(rest, g, vars)
  if (name === 'pwsh' || name === 'powershell') return classifyPwshHost(rest, dialect, g, vars, depth)
  if ((name === 'bash' || name === 'sh') && args[0] === '-c') return classifyNested(rest.slice(1), dialect, 'bash', g, depth)
  if (name === 'pip' || name === 'pip3' || ((name === 'python' || name === 'python3' || name === 'py') && args[0] === '-m' && args[1] === 'pip')) {
    return args.includes('install') || args.includes('download')
      ? escalate('pip-install', 'pip install downloads packages from the network')
      : allow('pip-read')
  }
  if ((name === 'python' || name === 'python3' || name === 'py') && programArg(args) === '-') {
    return escalate('inline-stdin-code', 'python reads its program from stdin, which the gate cannot inspect')
  }
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'npx') {
    return escalate('node-package', `${name} may download and run packages`)
  }
  if (name === 'icacls') return allow('icacls-read') // write forms are denied above
  if (name === 'fsutil') {
    return /^volume$/i.test(args[0] ?? '') && /^diskfree$/i.test(args[1] ?? '')
      ? allow('fsutil-diskfree')
      : escalate('unknown-command', `fsutil ${args[0] ?? ''} is not a recognized read-only form`)
  }
  if (name === 'powercfg') {
    return /^[/-](getactivescheme|list|l|query|q)$/i.test(args[0] ?? '')
      ? allow('powercfg-read')
      : escalate('unknown-command', `powercfg ${args[0] ?? ''} is not a recognized read-only form`)
  }
  if (dialect === 'pwsh' && (name === 'start-process' || name === 'saps' || name === 'start')) return classifyStartProcess(rest, g, vars, depth, info)
  // Loading a framework assembly by name (e.g. Microsoft.VisualBasic for the memory size) defines no code.
  if (name === 'add-type' && /^-a(s(s(e(m(b(l(y(n(a(m(e)?)?)?)?)?)?)?)?)?)?)?$/i.test(args[0] ?? '') && args.length >= 2
    && args.slice(1).every(a => /^[A-Za-z][\w.]*,?$/.test(a))) return allow('add-type-assembly')
  // Constructing a pure data type (`New-Object IO.DriveInfo('D')` for the free space, a generic list):
  // no code runs. COM objects and every other type still need an approver (findings 31, overnight S11/S17).
  if (name === 'new-object') {
    const k = /^-t(y(p(e(n(a(m(e)?)?)?)?)?)?)?$/i.test(args[0] ?? '') ? 1 : 0
    const type = /^([A-Za-z][\w.]*)(?:\[[\w.,\s[\]]*\])?(?:\(|$|,)/.exec(args[k]?.replace(SUB_RE, '(') ?? '')?.[1]
    if (type !== undefined && !args.some(a => /^-com/i.test(a)) && (isPureDotnet(type, 'new') || PURE_NEW_TYPES.test(type))) {
      return checkRedirects(rest, g, 'new-object-pure', vars, dialect)
    }
  }
  if (/^(invoke-expression|iex|start-process|saps|start|new-object|add-type|invoke-command|icm|start-job)$/.test(name)) {
    return escalate('dynamic-exec', `${name} executes dynamic or out-of-band code`)
  }
  const allowed = ALLOW_COMMANDS.has(name) || READ_CMDLET.test(name) || (g.config?.allowCommands ?? []).includes(name)
  if (!allowed) {
    const program = /[\\/]/.test(head) ? allowedProgram(head, g) : undefined
    if (program !== undefined) return judgeProgram(program, rest, g, vars, dialect)
    // A script or binary that lives inside the workspace (a build script, a cargo-built exe)
    // runs under the same OS write confinement as any allowed build command.
    if (/[\\/]/.test(head) && /\.(ps1|sh|bat|cmd|exe|py)$/i.test(head) && isWithinAny(g.roots, resolveIn(g, g.cwd, head), g.platform)) {
      if (dotSourced && /\.ps1$/i.test(head)) importFunctions(resolveIn(g, g.cwd, head), g, info)
      return checkRedirects(rest, g, 'workspace-script', vars, dialect)
    }
    return escalate('unknown-command', `no rule recognizes command "${name}"`)
  }
  if (WRITE_COMMANDS.has(name)) return checkWriteTargets(name, rest, g, vars, dialect)
  if (name === 'python' || name === 'python3' || name === 'py' || name === 'node') return checkRedirects(rest, g, 'run-script', vars, dialect)
  return checkRedirects(rest, g, `shell:${name}`, vars, dialect)
}

/** The program a python command line runs: a script path, `-` (stdin), or the `-c`/`-m` marker. */
function programArg(args: readonly string[]): string | undefined {
  for (const a of args) {
    if (a === '-' || a === '-c' || a === '-m') return a
    if (!a.startsWith('-')) return a
  }
  return undefined
}

/** Classify the command string handed to a nested shell (`cmd /c …`, `pwsh -Command …`, `bash -c …`). */
function classifyNested(rawRest: readonly string[], outer: Dialect, inner: Dialect, g: GateContext, depth: number, vars?: Vars): Verdict {
  if (rawRest.length === 0) return escalate('unknown-command', 'a nested shell without a command')
  const only = rawRest.length === 1 ? rawRest[0] as string : undefined
  // The outer PowerShell expands variables in a double-quoted command before the child sees it.
  const expanded = outer === 'pwsh' && vars !== undefined && only !== undefined && /^"[\s\S]*"$/.test(only) ? expandDoubleQuoted(only.slice(1, -1), vars) : undefined
  let text = expanded ?? (only !== undefined ? unquote(only, outer) : rawRest.join(' '))
  if (rawRest.length > 1 && /^"[\s\S]*"$/.test(text)) text = text.slice(1, -1)
  return classifyCommand(text, g, inner, depth + 1)
}

/** `pwsh`/`powershell` started as a child: judge its `-Command` text or `-File` script; anything else escalates. */
function classifyPwshHost(rest: readonly string[], outer: Dialect, g: GateContext, vars: Vars, depth: number): Verdict {
  for (let k = 0; k < rest.length; k++) {
    const t = unquote(rest[k] as string, outer).toLowerCase()
    if (/^-(e|ec|en|enc|enco|encod|encode|encoded\w*)$/.test(t)) return escalate('encoded-command', 'an encoded PowerShell command cannot be inspected')
    if (t === '-c' || t === '-command') return classifyNested(rest.slice(k + 1), outer, 'pwsh', g, depth, vars)
    if (t === '-f' || t === '-file') return classifyScript(rest[k + 1], rest.slice(k + 2), g, vars, outer)
    if (PWSH_VALUE_OPTIONS.has(t)) {
      k++
      continue
    }
    if (t.startsWith('-')) continue
    return classifyNested(rest.slice(k), outer, 'pwsh', g, depth, vars) // a positional argument is the command
  }
  return escalate('unknown-command', 'a nested PowerShell without -Command or -File starts an interactive shell')
}

/** A script handed to a child shell: inside the workspace it runs like any workspace script. */
function classifyScript(raw: string | undefined, rest: readonly string[], g: GateContext, vars: Vars, dialect: Dialect): Verdict {
  const script = raw === undefined ? undefined : literalValue(raw, vars, dialect)
  if (script === undefined) return dynamicCommand()
  if (!isWithinAny(g.roots, resolveIn(g, g.cwd, script), g.platform)) {
    return escalate('script-outside-root', `script ${script} is outside the workspace roots`)
  }
  return checkRedirects(rest, g, 'workspace-script', vars, dialect)
}

/**
 * Local git subcommands that create or overwrite files in a work tree. Their operands are write
 * targets like any other (review N1: `git worktree add ../b/x` wrote into another session's scope).
 */
const GIT_TREE_WRITERS = new Set(['checkout', 'switch', 'restore', 'stash', 'mv', 'rm', 'worktree', 'init'])
/** Options of those subcommands that take a separate value which is not a path. */
const GIT_OPERAND_VALUE_OPTIONS = new Set(['-b', '-B', '-c', '-C', '--orphan', '-s', '--source', '--reason', '--conflict', '--pathspec-from-file', '--template', '--separate-git-dir', '--initial-branch'])

/**
 * The write targets of a tree-writing git subcommand, judged like any write (roots, protected
 * paths, the session's scope). An operation that may rewrite the whole work tree (a branch switch,
 * a stash) is judged on the work tree itself. Returns undefined when everything is in scope.
 */
function judgeGitOperands(sub: string, args: readonly string[], g: GateContext, tree: string): Verdict | undefined {
  const dashes = args.indexOf('--')
  const before: string[] = []
  const paths: string[] = []
  for (let i = 0; i < args.length; i++) {
    const t = args[i] as string
    if (i === dashes) continue
    if (dashes >= 0 && i > dashes) {
      paths.push(t)
      continue
    }
    if (t.startsWith('-')) {
      if (t === '--pathspec-from-file' || t.startsWith('--pathspec-from-file=')) return escalate('git-pathspec', `git ${sub} reads its paths from a file`)
      if (GIT_OPERAND_VALUE_OPTIONS.has(t)) i++
      continue
    }
    before.push(t)
  }
  const target = (p: string, destructive: boolean): Verdict | undefined => {
    // Pathspec magic (`:/`, `:(top)`) and globs reach beyond the literal path.
    if (/^:/.test(p) || /[*?[]/.test(p)) return escalate('git-pathspec', `git ${sub} pathspec "${p}" may reach beyond its literal path`)
    const v = judgeTarget(p, g, destructive)
    return v.kind === 'allow' ? undefined : v
  }
  const wholeTree = (): Verdict | undefined => target(tree, false)
  const first = (list: readonly (Verdict | undefined)[]) => list.find(v => v !== undefined)
  switch (sub) {
    case 'init':
      return target(before[0] ?? '.', false)
    case 'worktree': {
      const [action, ...ops] = before
      if (action === 'add') return ops[0] === undefined ? undefined : target(ops[0], false)
      if (action === 'remove' || action === 'move') return first(ops.map(p => target(p, true)))
      return undefined // list, prune, lock, unlock, repair
    }
    case 'mv':
    case 'rm':
      return first([...before, ...paths].map(p => target(p, true)))
    case 'restore':
      // Without paths git refuses to restore; with paths only they change.
      return first([...before, ...paths].map(p => target(p, false)))
    case 'checkout':
      // `checkout <branch>` rewrites the work tree; `checkout [<tree>] -- <paths>` only the paths;
      // `checkout -b <new>` without a start point changes no file.
      if (paths.length > 0) return first(paths.map(p => target(p, false)))
      if (before.length === 0) return undefined
      return first([wholeTree(), ...before.slice(1).map(p => target(p, false))])
    case 'stash':
      return before[0] === 'list' || before[0] === 'show' ? undefined : wholeTree()
    default: // switch
      return before.length === 0 ? undefined : wholeTree()
  }
}

/** git options that take a value before the subcommand (`git -C dir status`). */
const GIT_VALUE_OPTIONS = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace'])

function classifyGit(rest: string[], g: GateContext): Verdict {
  let sub: string | undefined
  let subAt = -1
  let outside: string | undefined
  // Where git runs (`-C` applies in order, relative to the previous one) and an explicit work tree.
  let dir = g.cwd
  let workTree: string | undefined
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i] as string
    const eq = /^(--git-dir|--work-tree)=(.*)$/.exec(t)
    if (GIT_VALUE_OPTIONS.has(t) || eq !== null) {
      const opt = eq !== null ? eq[1] as string : t
      const value = eq !== null ? eq[2] : rest[i + 1]
      if (opt !== '-c' && opt !== '--namespace' && value !== undefined) {
        const resolved = resolveIn(g, dir, value)
        if (!isWithinAny(g.roots, resolved, g.platform)) outside ??= value
        if (opt === '-C') dir = resolved
        if (opt === '--work-tree') workTree = resolved
      }
      if (eq === null) i++
      continue
    }
    if (!t.startsWith('-')) {
      sub = t.toLowerCase()
      subAt = i
      break
    }
  }
  // Global options (`git -C dir push`) hide the subcommand from the deny patterns; re-check it here.
  const next = rest[subAt + 1]?.toLowerCase()
  if (sub === 'push' || (sub === 'remote' && next !== undefined && ['add', 'set-url', 'remove', 'rename'].includes(next)) ||
    (sub === 'config' && (next === '--global' || next === '--system'))) {
    return deny('git-remote', 'pushing or changing remotes/global git config is reserved to the orchestrator')
  }
  if (outside !== undefined) return escalate('git-outside-root', `git operates on ${outside}, outside the workspace roots`)
  if (sub === undefined) return allow('git-info')
  if (GIT_TREE_WRITERS.has(sub)) {
    const at = { ...g, cwd: dir }
    const verdict = judgeGitOperands(sub, rest.slice(subAt + 1), at, workTree ?? g.gitTopLevel?.(dir) ?? dir)
    if (verdict !== undefined) return verdict
  }
  if (GIT_LOCAL.has(sub)) return allow(`git-${sub}`)
  if (GIT_NETWORK.has(sub)) return escalate('git-network', `git ${sub} reaches a remote`)
  return escalate('git-other', `git ${sub}`)
}

/** Judge one raw target token: resolve literals and earlier assignments, else it cannot be checked. */
function judgeRaw(raw: string, g: GateContext, destructive: boolean, vars: Vars, dialect: Dialect): Verdict {
  for (const piece of splitTopLevelCommas(raw)) {
    const value = literalValue(piece, vars, dialect)
    const v = value === undefined
      ? escalate('dynamic-target', `cannot resolve ${destructive ? 'delete/move' : 'write'} target "${piece.replace(SUB_RE, '(…)')}" statically`)
      : judgeTarget(value, g, destructive)
    if (v.kind !== 'allow') return v
  }
  return allow('target-in-root')
}

/** Collect redirection targets (`> f`, `>> f`, `>f`, `2> f`) and judge them. */
function checkRedirects(rest: readonly string[], g: GateContext, rule: string, vars: Vars, dialect: Dialect): Verdict {
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i] as string
    const m = /^(?:\d|\*)?>>?(.*)$/.exec(t)
    if (m === null) continue
    const target = m[1] !== '' ? m[1] : rest[i + 1]
    if (target === undefined || /^&\d$/.test(target) || target === '$null' || /^\/dev\/null$/i.test(target) || /^nul$/i.test(target)) continue
    const v = judgeRaw(target, g, false, vars, dialect)
    if (v.kind !== 'allow') return v
  }
  return allow(rule)
}

function checkWriteTargets(name: string, rest: readonly string[], g: GateContext, vars: Vars, dialect: Dialect): Verdict {
  const redirect = checkRedirects(rest, g, `write:${name}`, vars, dialect)
  if (redirect.kind !== 'allow') return redirect
  const destructive = DELETE_COMMANDS.has(name) || name === 'mv' || name === 'move' || name === 'move-item'
  const targets: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i] as string
    const lower = unquote(t, dialect).toLowerCase()
    if (PATH_PARAMS.has(lower)) {
      const v = rest[i + 1]
      if (v !== undefined) targets.push(v)
      i++
      continue
    }
    if (VALUE_PARAMS.has(lower)) {
      i++
      continue
    }
    if (t.startsWith('-') || (t.startsWith('/') && g.platform === 'win32' && t.length <= 3)) continue // flags, cmd-style switches
    // Redirects are judged by checkRedirects. A bare operator (> >> 2> *>) owns the next token; an attached
    // one (>f) or a stream merge (2>&1) is complete in itself and must not swallow the next target.
    if (/^(\d|\*)?>>?$/.test(t)) {
      i++
      continue
    }
    if (/^(\d|\*)?>>?/.test(t)) continue
    // `Set-Content <path> <value>`: only the first positional argument is a path; the rest is data.
    if (SINGLE_PATH_COMMANDS.has(name) && targets.length > 0) continue
    targets.push(t)
  }
  for (const target of targets) {
    const v = judgeRaw(target, g, destructive, vars, dialect)
    if (v.kind !== 'allow') return v
  }
  return allow(`write:${name}`)
}

/** Judge one write/delete target path; environment references and globs above the last segment cannot be resolved statically. */
function judgeTarget(raw: string, g: GateContext, destructive: boolean): Verdict {
  if (raw.startsWith(SCRATCH)) return judgeScratch(raw.slice(SCRATCH.length), destructive)
  if (/^~[^\\/]/.test(raw)) return escalate('dynamic-target', `cannot resolve "${raw}" (another user's home or a provider path) statically`)
  // A wildcard confined to the last path segment cannot reach outside its literal directory: judge the directory.
  const glob = /^([^$*?`%]*)[\\/]([^\\/]*[*?][^\\/]*)$/.exec(raw)
  if (glob !== null && !/[$`%]|^\(|^@\(/.test(raw) && (glob[1] as string) !== '') return judgeGlobDir(glob[1] as string, g, destructive)
  if (/[$*?`%]|^\(|^@\(/.test(raw)) {
    return destructive
      ? escalate('dynamic-target', `cannot resolve delete/move target "${raw}" statically`)
      : escalate('dynamic-target', `cannot resolve write target "${raw}" statically`)
  }
  const target = resolveIn(g, g.cwd, raw)
  if (isCredentialPath(target, g)) return deny('credential-write', 'credential files are never writable by workers')
  if (isProtectedConfig(target, g)) return deny('config-write', 'harness, Claude and Codex configuration is reserved to the orchestrator')
  if (!isWithinAny(g.roots, target, g.platform)) {
    return deny('write-outside-root', `writes are confined to the workspace roots (${g.roots.join(', ')}); ${target} is outside`)
  }
  if (destructive && g.roots.some(root => isWithinAny([target], root, g.platform))) {
    return deny('delete-root', `refusing to delete or move a workspace root (${target})`)
  }
  return outsideScope(target, g) ?? allow('target-in-root')
}

/** `dir/*.log`: the wildcard only selects names inside `dir`, so `dir` decides; a wildcard over a whole root stays with an approver. */
function judgeGlobDir(rawDir: string, g: GateContext, destructive: boolean): Verdict {
  const dir = resolveIn(g, g.cwd, rawDir)
  const probe = `${dir}${g.platform === 'win32' ? '\\' : '/'}x`
  if (isCredentialPath(probe, g) || isCredentialPath(dir, g)) return deny('credential-write', 'credential files are never writable by workers')
  if (isProtectedConfig(probe, g)) return deny('config-write', 'harness, Claude and Codex configuration is reserved to the orchestrator')
  if (!isWithinAny(g.roots, dir, g.platform)) {
    return deny('write-outside-root', `writes are confined to the workspace roots (${g.roots.join(', ')}); ${dir} is outside`)
  }
  if (destructive && g.roots.some(root => isWithinAny([dir], root, g.platform))) {
    return escalate('dynamic-target', `a wildcard delete/move over a whole workspace root (${dir})`)
  }
  return outsideScope(dir, g) ?? allow('target-glob-in-root')
}

// ── precise allowances (phase 2) ──────────────────────────────────────────

/** Path text compared case- and slash-insensitively on Windows, slash-normalized elsewhere. */
function samePath(a: string, b: string, platform: Platform): boolean {
  const norm = (p: string) => {
    const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
    return platform === 'win32' ? s.toLowerCase() : s
  }
  return norm(a) === norm(b)
}

/**
 * A write under the worker's private temp directory (`$env:TEMP`/`$env:TMP` in the sandbox). `..`
 * could climb out of it and a wildcard delete over the whole directory is not scratch cleanup.
 */
function judgeScratch(rest: string, destructive: boolean): Verdict {
  if (rest !== '' && !/^[\\/]/.test(rest)) return escalate('dynamic-target', 'a path glued to $env:TEMP cannot be resolved statically')
  const parts = rest.split(/[\\/]+/).filter(p => p !== '')
  if (parts.some(p => p === '..' || /[$`%]/.test(p))) return escalate('dynamic-target', 'a temp path that climbs out with .. or holds a variable')
  if (parts.length === 0) return escalate('dynamic-target', 'writing to or deleting the temp directory itself')
  if (destructive && parts.length === 1 && /[*?]/.test(parts[0] as string)) return escalate('dynamic-target', 'a wildcard delete over the whole temp directory')
  return allow('scratch-write')
}

/** `$x = Join-Path <literal> <literal>…`: the joined path when every part is known. */
function joinPathValue(rhs: readonly string[], vars: Vars, dialect: Dialect): string | undefined {
  if (dialect !== 'pwsh' || rhs.length < 3 || commandName(rhs[0] as string) !== 'join-path') return undefined
  const parts: string[] = []
  for (let k = 1; k < rhs.length; k++) {
    const t = rhs[k] as string
    const lower = t.toLowerCase()
    if (lower === '-path' || lower === '-childpath') continue
    if (t.startsWith('-')) return undefined // -Resolve, -AdditionalChildPath, …: not modeled
    const v = literalValue(t, vars, dialect)
    if (v === undefined || v === '') return undefined
    parts.push(v)
  }
  if (parts.length < 2) return undefined
  return parts.map((p, k) => (k === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, ''))).join('/')
}

/**
 * A loader-environment assignment allowed by `allowEnv`: either exactly one of `values`, or the
 * current value (`$env:NAME` / `$NAME`) with only the listed directories added before or after it.
 */
function allowedEnv(name: string, raw: string, g: GateContext, vars: Vars, dialect: Dialect): boolean {
  const entries = (g.config?.allowEnv ?? []).filter(e => e.name.toLowerCase() === name.toLowerCase())
  if (entries.length === 0) return false
  const current = '\u0000current'
  const scoped: Vars = new Map(vars)
  scoped.set(dialect === 'pwsh' ? `env:${name.toLowerCase()}` : name.toLowerCase(), current)
  const value = literalValue(raw, scoped, dialect)
  if (value === undefined || value.includes(SCRATCH)) return false
  const sep = g.platform === 'win32' ? ';' : ':'
  for (const e of entries) {
    if ((e.values ?? []).some(v => samePath(v, value, g.platform))) return true
    if (e.prepend === undefined && e.append === undefined) continue
    const parts = value.split(sep)
    const at = parts.indexOf(current)
    if (at < 0 || parts.lastIndexOf(current) !== at) continue
    const listed = (list: readonly string[] | undefined, p: string) => p !== '' && (list ?? []).some(d => samePath(d, p, g.platform))
    if (parts.slice(0, at).every(p => listed(e.prepend, p)) && parts.slice(at + 1).every(p => listed(e.append, p))) return true
  }
  return false
}

/** The `allowPrograms` entry for a program path, if any. */
function allowedProgram(head: string, g: GateContext): AllowProgram | undefined {
  if (head.includes('\u0000')) return undefined
  const target = resolveIn(g, g.cwd, head)
  return (g.config?.allowPrograms ?? []).find(p => samePath(resolveIn(g, g.cwd, p.path), target, g.platform))
}

function judgeProgram(p: AllowProgram, rest: readonly string[], g: GateContext, vars: Vars, dialect: Dialect): Verdict {
  const args = rest.map(t => unquote(t, dialect))
  if (p.args !== undefined && !new RegExp(p.args, 'i').test(args.join(' '))) {
    return escalate('unknown-command', `${p.path} is allowed only with arguments matching /${p.args}/`)
  }
  if (p.scriptFlag !== undefined) {
    const flag = p.scriptFlag.toLowerCase()
    const k = args.findIndex(a => a.toLowerCase() === flag)
    if (k >= 0) {
      const raw = rest[k + 1]
      const script = raw === undefined ? undefined : literalValue(raw, vars, dialect)
      if (script === undefined) return dynamicCommand()
      if (!isWithinAny(g.roots, resolveIn(g, g.cwd, script), g.platform)) {
        return escalate('script-outside-root', `script ${script} is outside the workspace roots`)
      }
    }
  }
  return checkRedirects(rest, g, 'allowed-program', vars, dialect)
}

/**
 * `$p = Start-Process … -PassThru` whose own process object is waited for in code (not in a string
 * or comment): `$p.WaitForExit(…)`, `$p | Wait-Process`, `Wait-Process -InputObject $p` / `-Id $p.Id`.
 */
function waitedFor(info: CommandInfo, switches: ReadonlySet<string>): boolean {
  const v = info.assigned
  if (v === undefined || !/^\w+$/.test(v) || !switches.has('passthru')) return false
  if (new RegExp(String.raw`\$${v}\.WaitForExit\s*\(|\$${v}\s*\|\s*Wait-Process\b|\bWait-Process\b[^;|\r\n]*\$${v}\b`, 'i').test(info.code)) return true
  // A poll loop on HasExited that kills the process on its deadline (finding 53).
  return new RegExp(String.raw`\b(?:while|until)\s*\(\s*(?:-not\s+|!\s*)?\(?\s*\$${v}\.HasExited\b`, 'i').test(info.code)
    && new RegExp(String.raw`\$${v}\.Kill\s*\(`, 'i').test(info.code)
}

/** Names the gate judges as commands of their own; a function by that name would be misread. */
const KNOWN_COMMAND_NAMES = /^(git|curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm|cmd|pwsh|powershell|bash|sh|pip3?|python3?|py|node|npm|pnpm|yarn|npx|icacls|fsutil|powercfg|start-process|saps|start|add-type|invoke-expression|iex|new-object|invoke-command|icm|start-job|cargo|rustc)$/
function shadowsCommand(name: string, g: GateContext): boolean {
  return ALLOW_COMMANDS.has(name) || WRITE_COMMANDS.has(name) || DELETE_COMMANDS.has(name) || KNOWN_COMMAND_NAMES.test(name) || CD_COMMANDS.has(name) || (g.config?.allowCommands ?? []).includes(name)
}

/** Functions defined at the top level of a dot-sourced workspace script become known to the command. */
function importFunctions(script: string, g: GateContext, info: CommandInfo): void {
  const text = g.readScript?.(script)
  if (text === undefined) return
  for (const m of text.matchAll(/^[ \t]*(?:function|filter)[ \t]+([\w-]+)/gim)) info.functions.add((m[1] as string).toLowerCase())
}

/**
 * The text a double-quoted PowerShell string becomes once the outer shell expands it, when that is
 * fully known: known variables substituted, environment variables left for the child (it inherits
 * them), simple backtick escapes applied. Anything else (subexpressions, unknown variables) → undefined.
 */
function expandDoubleQuoted(body: string, vars: Vars): string | undefined {
  if (body.includes(SUB)) return undefined
  let out = ''
  for (let k = 0; k < body.length; k++) {
    const c = body[k] as string
    if (c === '`') {
      const n = body[k + 1]
      if (n !== '$' && n !== '"' && n !== '`' && n !== '\'') return undefined
      out += n
      k++
      continue
    }
    if (c !== '$') {
      out += c
      continue
    }
    const m = /^\$(?:\{([^}]+)\}|([A-Za-z_]\w*(?::\w+)?))/.exec(body.slice(k))
    if (m === null) {
      out += c
      continue
    }
    const name = (m[1] ?? m[2] ?? '').toLowerCase()
    if (name.startsWith('env:')) {
      out += m[0]
    } else {
      const v = vars.get(name)
      if (v === undefined || v.includes('\u0000')) return undefined
      out += v
    }
    k += m[0].length - 1
  }
  return out
}

const START_PROCESS_PARAMS = ['filepath', 'argumentlist', 'workingdirectory', 'redirectstandardoutput', 'redirectstandarderror',
  'redirectstandardinput', 'verb', 'wait', 'nonewwindow', 'passthru', 'windowstyle', 'credential', 'loaduserprofile',
  'usenewenvironment', 'environment', 'useshellexecute']
const START_PROCESS_ALIASES: Readonly<Record<string, string>> = {
  path: 'filepath', pspath: 'filepath', lp: 'filepath', args: 'argumentlist', rso: 'redirectstandardoutput',
  rse: 'redirectstandarderror', rsi: 'redirectstandardinput', nnw: 'nonewwindow', lup: 'loaduserprofile',
}
const START_PROCESS_SWITCHES = new Set(['wait', 'nonewwindow', 'passthru', 'loaduserprofile', 'usenewenvironment', 'useshellexecute'])
const START_PROCESS_REFUSED = ['credential', 'loaduserprofile', 'usenewenvironment', 'environment', 'useshellexecute']

/** A `-Name` token resolved to a Start-Process parameter (full name, alias, or unique prefix). */
function startProcessParam(token: string): string | undefined {
  const n = token.slice(1).replace(/:.*$/, '').toLowerCase()
  const alias = START_PROCESS_ALIASES[n]
  if (alias !== undefined) return alias
  if (START_PROCESS_PARAMS.includes(n)) return n
  const hits = START_PROCESS_PARAMS.filter(p => p.startsWith(n))
  return hits.length === 1 ? hits[0] : undefined
}

const quoteLiteral = (s: string) => `'${s.replace(/'/g, '\'\'')}'`

/**
 * `Start-Process` judged like a direct call of the program it starts, provided the command waits
 * for it (`-Wait`, `$p.WaitForExit(ms)`, `Wait-Process`): an unwaited process outlives the call
 * (findings 40). Redirect files are write targets, the working directory must be inside the roots,
 * and elevation is refused.
 */
function classifyStartProcess(rest: readonly string[], g: GateContext, vars: Vars, depth: number, info: CommandInfo): Verdict {
  const values = new Map<string, string[]>()
  const switches = new Set<string>()
  const positional: string[][] = []
  for (let k = 0; k < rest.length; k++) {
    const t = rest[k] as string
    let param: string | undefined
    if (/^-[A-Za-z]/.test(t)) {
      param = startProcessParam(t)
      if (param === undefined) return escalate('dynamic-exec', `Start-Process with an unrecognized parameter ${t}`)
      if (START_PROCESS_SWITCHES.has(param)) {
        switches.add(param)
        continue
      }
      k++
    }
    // One value, possibly a comma list spread over tokens (`'a', 'b'`).
    const value: string[] = []
    while (k < rest.length) {
      const v = rest[k] as string
      value.push(v)
      if (!v.endsWith(',') && !(rest[k + 1] ?? '').startsWith(',')) break
      k++
    }
    if (value.length === 0) return escalate('dynamic-exec', `Start-Process ${t} without a value`)
    if (param === undefined) positional.push(value)
    else values.set(param, value)
  }
  if (!values.has('filepath') && positional[0] !== undefined) values.set('filepath', positional.shift() as string[])
  if (!values.has('argumentlist') && positional[0] !== undefined) values.set('argumentlist', positional.shift() as string[])
  if (positional.length > 0) return escalate('dynamic-exec', 'Start-Process with arguments the gate cannot place')

  for (const p of START_PROCESS_REFUSED) {
    if (values.has(p) || switches.has(p)) return escalate('dynamic-exec', `Start-Process -${p} changes who or what runs the program`)
  }
  const verb = values.get('verb')
  if (verb !== undefined) {
    const v = literalValue(verb.join(''), vars, 'pwsh')
    return v !== undefined && /^runas$/i.test(v)
      ? deny('elevation', 'starting a program elevated (-Verb RunAs) is not allowed for workers')
      : escalate('dynamic-exec', 'Start-Process with a shell verb')
  }
  const fileRaw = values.get('filepath')
  if (fileRaw === undefined || fileRaw.length !== 1) return escalate('dynamic-exec', 'Start-Process without a single literal program')
  const file = literalValue(fileRaw[0] as string, vars, 'pwsh')
  if (file === undefined) return dynamicCommand()
  if (!switches.has('wait') && !waitedFor(info, switches)) {
    return escalate('detached-process', 'Start-Process without -Wait or $p.WaitForExit(ms) leaves the program running after this call; wait for it with a timeout and kill it on expiry')
  }
  const wd = values.get('workingdirectory')
  if (wd !== undefined) {
    const dir = wd.length === 1 ? literalValue(wd[0] as string, vars, 'pwsh') : undefined
    if (dir === undefined) return escalate('dynamic-target', 'Start-Process working directory cannot be resolved statically')
    if (!isWithinAny(g.roots, resolveIn(g, g.cwd, dir), g.platform)) return escalate('workdir-outside-root', `working directory ${dir} is outside the workspace roots`)
  }
  for (const p of ['redirectstandardoutput', 'redirectstandarderror']) {
    const target = values.get(p)
    if (target === undefined) continue
    if (target.length !== 1) return escalate('dynamic-target', `Start-Process -${p} target cannot be resolved statically`)
    const v = judgeRaw(target[0] as string, g, false, vars, 'pwsh')
    if (v.kind !== 'allow') return v
  }

  // The program and its argument list, judged as the direct call they amount to.
  let argTokens: string[] | undefined = []
  const list = values.get('argumentlist')
  if (list !== undefined) {
    const items = literalList(list, vars, 'pwsh')
    if (items !== undefined) argTokens = items.map(quoteLiteral)
    else {
      // One string holding the whole argument line.
      const one = list.length === 1 ? literalValue(list[0] as string, vars, 'pwsh') : undefined
      argTokens = one === undefined ? undefined : tokenize(one, 'pwsh').map(quoteLiteral)
    }
  }
  if (argTokens === undefined) {
    // Arguments computed at run time: only a workspace binary runs the same whatever its arguments.
    const inRoots = /[\\/]/.test(file) && /\.(exe|bat|cmd|com)$/i.test(file) && isWithinAny(g.roots, resolveIn(g, g.cwd, file), g.platform)
    return inRoots ? allow('start-process') : escalate('dynamic-exec', `Start-Process ${file} with arguments computed at run time`)
  }
  const verdict = classifySegment(['&', quoteLiteral(file), ...argTokens], g, 'pwsh', new Map(vars), depth, info)
  return verdict.kind === 'allow' ? allow('start-process') : verdict
}
