/**
 * The orchestrator's quiet-mode switch. Quiet mode (heavy commands wait while a benchmark holds the
 * machine) used to be switched only in local-rules.json, which an AI orchestrator may not edit
 * (findings 51). This switch lives in memory, expires on its own, and every change is audited.
 */
export interface QuietOverride {
    readonly enabled: boolean;
    readonly until: string;
    readonly reason: string;
    readonly by: string;
}
export declare const MAX_QUIET_MINUTES: number;
export declare class QuietSwitch {
    private override;
    private readonly now;
    constructor(now?: () => number);
    set(enabled: boolean, minutes: number, reason: string, by: string): QuietOverride;
    clear(): void;
    /** The switch while it is in force; expired settings fall back to the configured behaviour. */
    current(): QuietOverride | undefined;
}
