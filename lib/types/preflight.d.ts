export interface PreflightIssue {
    readonly path: string;
    readonly problem: string;
    /** A suggested repair confined to the workspace; never run automatically. */
    readonly suggestion?: string;
}
/** True when an `icacls` listing carries a Low mandatory label (inheritable or explicit). */
export declare function hasLowLabel(listing: string): boolean;
export declare function preflightWorkspace(cwd: string, permissionPreset: string, platform?: NodeJS.Platform, run?: (dir: string) => Promise<string>): Promise<PreflightIssue[]>;
