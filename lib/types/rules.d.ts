/**
 * 飞沙堰 (Feishayan) — the deterministic rule tier of the permission gate.
 *
 * `classify` is a pure function of one tool call and its session context. It
 * returns `allow`, `deny` (with a reason the model can act on) or `escalate`
 * (an external approver must decide). Rules are deliberately conservative:
 * anything this module does not positively recognize escalates, and the
 * approver — not this file — decides the grey zone.
 */
import { type Platform } from './paths.ts';
export type Verdict = {
    readonly kind: 'allow';
    readonly rule: string;
} | {
    readonly kind: 'deny';
    readonly rule: string;
    readonly reason: string;
} | {
    readonly kind: 'escalate';
    readonly rule: string;
    readonly reason: string;
};
export interface RuleConfig {
    /** Extra first tokens treated like the built-in allowlist (lowercase, no extension). */
    readonly allowCommands?: readonly string[];
    /** Extra regular expressions (case-insensitive) that deny a shell command. */
    readonly denyPatterns?: readonly string[];
    /** Extra regular expressions marking benchmark commands that need the bench lease. */
    readonly benchPatterns?: readonly string[];
    /** Allow `web_search` without approval (default true); `web_fetch` always escalates. */
    readonly allowWebSearch?: boolean;
    /** Allow agents to start their own subagents (default false). */
    readonly allowSubagents?: boolean;
}
export interface GateContext {
    /** Canonical working directory of the calling session. */
    readonly cwd: string;
    /** Canonical workspace roots writes are confined to. */
    readonly roots: readonly string[];
    /** The user's home directory (for credential paths). */
    readonly home: string;
    readonly platform: Platform;
    /** Whether the calling session's current task holds the `bench` lease. */
    readonly holdsBench: boolean;
    readonly config?: RuleConfig;
    /** Path canonicalizer; defaults to resolving symlinks on the host. */
    readonly canonical?: (p: string) => string;
    /** Extra directories workers may never write (the plugin data dir: token, personal rules). */
    readonly protectedDirs?: readonly string[];
    /**
     * The calling session's own write scope (canonical, inside the roots). Workers sharing a root
     * otherwise write each other's files (prior art: dsh-crew cwd-lock, a real half-written file).
     */
    readonly writeScope?: readonly string[];
}
/** The reserved PTC transport; its program body bypasses per-call gating. */
export declare const RUN_CODE = "run_code";
/**
 * Classify one tool call.
 * @param tool - model-visible tool name.
 * @param args - the call's arguments (`exec.arguments`).
 * @param g - session context.
 * @param outerRunCode - true when this is an outer `run_code` call (not a PTC inner call).
 */
export declare function classify(tool: string, args: Readonly<Record<string, unknown>>, g: GateContext, outerRunCode?: boolean): Verdict;
export declare function isCredentialPath(p: string, g: Pick<GateContext, 'home' | 'platform' | 'protectedDirs'>): boolean;
/** Shell dialect of one command string: PowerShell, POSIX sh, or cmd.exe (inside `cmd /c`). */
export type Dialect = 'pwsh' | 'bash' | 'cmd';
/** Classify a full shell command line (bash or PowerShell dialect). */
export declare function classifyCommand(command: string, g: GateContext, dialect?: Dialect, depth?: number): Verdict;
/**
 * Split a command into simple commands: on unquoted `;`, `&&`, `||`, `|` and newlines (and `&` in
 * cmd), and around every nested `( … )`, `{ … }` and `$( … )` — also inside double quotes — and bash
 * backticks. A nested body becomes its own segment(s) and is classified like any other command; the
 * enclosing segment keeps a placeholder, so `Remove-Item (Join-Path a b)` still has an unresolvable
 * target. Quotes, escapes and here-strings (`@'…'@`) stay intact inside a segment.
 */
export declare function splitSegments(command: string, dialect?: Dialect): string[];
/** Whitespace tokenizer honoring single and double quotes (quotes removed). */
export declare function tokenize(segment: string, dialect?: Dialect): string[];
