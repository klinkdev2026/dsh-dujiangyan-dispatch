import type { EventLog } from './events.ts';
import type { RuleConfig } from './rules.ts';
export declare const LOCAL_RULES_FILE = "local-rules.json";
export interface Hint {
    /** Regular expression (case-insensitive) tested against the call text (the shell command, or the tool arguments as JSON). */
    readonly match: string;
    /** Only for this tool (e.g. `pwsh`); any tool when absent. */
    readonly tool?: string;
    /** The deny reason the worker receives. */
    readonly reason: string;
}
export interface RuleLayer {
    readonly rules?: Pick<RuleConfig, 'allowCommands' | 'denyPatterns' | 'benchPatterns' | 'allowEnv' | 'allowPrograms'>;
    readonly hints?: readonly Hint[];
    readonly facts?: readonly string[];
    /** In a `workspaces` layer only: the AI judges of sessions working in that folder. */
    readonly aiApproval?: {
        readonly judges?: ReadonlyArray<{
            provider: string;
            model: string;
            effort?: string;
        }>;
    };
}
export interface LocalRulesFile extends RuleLayer {
    /** Layers applied only to sessions whose working directory is inside the given root. */
    readonly workspaces?: Readonly<Record<string, RuleLayer>>;
    /** Overrides of the profile `aiApproval` setting (top level only). */
    readonly aiApproval?: {
        readonly enabled?: boolean;
        readonly judges?: ReadonlyArray<{
            provider: string;
            model: string;
            effort?: string;
        }>;
        readonly timeoutMs?: number;
        readonly maxPerSessionPer10Min?: number;
    };
    /** Overrides of the profile `quietMode` setting (top level only); patterns are added to the profile ones. */
    readonly quietMode?: {
        readonly enabled?: boolean;
        readonly patterns?: readonly string[];
    };
    /** Extra workspace roots (top level only), added to the profile ones without a desktop restart. */
    readonly workspaceRoots?: readonly string[];
}
export interface EffectiveRules {
    readonly rules: RuleConfig;
    readonly hints: ReadonlyArray<{
        readonly id: string;
        readonly re: RegExp;
        readonly tool?: string;
        readonly reason: string;
    }>;
    readonly facts: readonly string[];
}
export declare function parseLocalRules(text: string): {
    ok: true;
    value: LocalRulesFile;
} | {
    ok: false;
    error: string;
};
/** The base rule config with every layer's patterns appended (layers only add; they never remove a base rule). */
export declare function mergeRules(base: RuleConfig, layers: readonly RuleLayer[]): RuleConfig;
export interface LocalRulesStatus {
    readonly file: string;
    readonly present: boolean;
    readonly loadedAt?: string;
    readonly lastError?: string;
    readonly lastErrorAt?: string;
    readonly content: LocalRulesFile;
}
export declare class LocalRules {
    readonly file: string;
    private current;
    private present;
    private loadedAt;
    private lastError;
    private lastErrorAt;
    private watcher;
    private timer;
    private readonly events;
    private readonly audit;
    private readonly base;
    private readonly home;
    constructor(deps: {
        stateDir: string;
        events: EventLog;
        audit: (record: Record<string, unknown>) => void;
        base: () => RuleConfig;
        home?: string;
    });
    /** Re-read the file. A missing file means no personal rules; an invalid one keeps the last good version. */
    reload(): {
        ok: true;
        present: boolean;
    } | {
        ok: false;
        error: string;
    };
    /** Watch the data directory (the file may not exist yet); changes apply after a short debounce. */
    watch(): void;
    close(): void;
    status(): LocalRulesStatus;
    /** The layers that apply to a working directory: the top level, then each workspace root that contains it. */
    layersFor(cwd: string | undefined, platform?: NodeJS.Platform): RuleLayer[];
    effective(cwd: string | undefined, platform?: NodeJS.Platform): EffectiveRules;
    /** The file's extra workspace roots, canonical. */
    workspaceRoots(platform?: NodeJS.Platform): string[];
    /**
     * A root that would put the home directory or the plugin data directory (rules, token) inside
     * the workers' reach; the gate also protects them, but such a root is never what was meant.
     */
    private unsafeRoot;
    /** The judges of the most specific workspace layer containing `cwd` that names judges, if any. */
    workspaceJudges(cwd: string, platform?: NodeJS.Platform): ReadonlyArray<{
        provider: string;
        model: string;
        effort?: string;
    }> | undefined;
    /** The file's `aiApproval` overrides, if any. */
    aiApproval(): LocalRulesFile['aiApproval'];
    /** The file's `quietMode` overrides, if any. */
    quietMode(): LocalRulesFile['quietMode'];
    private invalid;
    private report;
}
/** The text a hint is matched against: the shell command, else the arguments as JSON (both also with `/` for `\`). */
export declare function hintSubject(args: Readonly<Record<string, unknown>>): string;
export declare function matchHint(rules: EffectiveRules, tool: string, args: Readonly<Record<string, unknown>>): EffectiveRules['hints'][number] | undefined;
