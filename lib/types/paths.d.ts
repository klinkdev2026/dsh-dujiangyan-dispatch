import path from 'node:path';
export type Platform = NodeJS.Platform;
/** The path implementation matching a platform (injectable for tests). */
export declare function pathApi(platform?: Platform): typeof path.posix;
/** Default filesystems on Windows and macOS compare names case-insensitively. */
export declare function isCaseInsensitive(platform?: Platform): boolean;
/**
 * Canonicalize a path: resolve symlinks/junctions for the longest existing
 * prefix and keep the not-yet-existing tail lexical, so a file about to be
 * created is judged by where it will really land.
 */
export declare function canonicalPath(p: string, platform?: Platform, realpath?: (p: string) => string): string;
/** True when `target` is `root` itself or lies below it. Both must be absolute. */
export declare function isWithin(root: string, target: string, platform?: Platform): boolean;
/** True when `target` lies within any of `roots`. */
export declare function isWithinAny(roots: readonly string[], target: string, platform?: Platform): boolean;
/**
 * Turn an arbitrary name into a file-name-safe key: ASCII letters, digits,
 * `-` and `_`, at most 48 characters, never a Windows reserved device name.
 */
export declare function safeKey(name: string): string;
/** The Harness home: `$DSH_HOME`, else `~/.dsh`. */
export declare function dshHome(env?: NodeJS.ProcessEnv, home?: string): string;
/** The current user's home directory, honoring USERPROFILE on Windows. */
export declare function homeDir(env?: NodeJS.ProcessEnv): string;
