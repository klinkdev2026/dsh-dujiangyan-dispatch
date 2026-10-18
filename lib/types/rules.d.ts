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
export declare function isCredentialPath(p: string, g: Pick<GateContext, 'home' | 'platform'>): boolean;
/** Classify a full shell command line (bash or PowerShell dialect). */
export declare function classifyCommand(command: string, g: GateContext): Verdict;
/** Split on unquoted `;`, `&&`, `||`, `|` and newlines. */
export declare function splitSegments(command: string): string[];
/** Whitespace tokenizer honoring single and double quotes (quotes removed). */
export declare function tokenize(segment: string): string[];
