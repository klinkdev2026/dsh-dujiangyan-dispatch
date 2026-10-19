export interface EnvironmentFacts {
    /** Free bytes per workspace root, measured when the facts were built (undefined if unreadable). */
    readonly freeBytes: ReadonlyArray<{
        readonly root: string;
        readonly free: number | undefined;
    }>;
    readonly platform: NodeJS.Platform;
    readonly permissionPreset: string;
}
export declare function measureFacts(roots: readonly string[], permissionPreset: string, platform?: NodeJS.Platform): EnvironmentFacts;
/** The short "Environment facts" block appended to a task prompt. */
export declare function describeFacts(f: EnvironmentFacts, extra?: readonly string[]): string;
