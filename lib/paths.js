/**
 * Cross-platform path rules shared by the gate, the store and preflight.
 *
 * Every containment check in this package goes through {@link isWithin}: it
 * compares `path.relative` results instead of string prefixes (the upstream
 * `startsWith(root + '/')` check never matches Windows paths) and folds case on
 * the platforms whose default filesystems are case-insensitive.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
/** The path implementation matching a platform (injectable for tests). */
export function pathApi(platform = process.platform) {
    return platform === 'win32' ? path.win32 : path.posix;
}
/** Default filesystems on Windows and macOS compare names case-insensitively. */
export function isCaseInsensitive(platform = process.platform) {
    return platform === 'win32' || platform === 'darwin';
}
/**
 * Canonicalize a path: resolve symlinks/junctions for the longest existing
 * prefix and keep the not-yet-existing tail lexical, so a file about to be
 * created is judged by where it will really land.
 */
export function canonicalPath(p, platform = process.platform, realpath = realpathSync.native) {
    const api = pathApi(platform);
    const absolute = api.resolve(p);
    let current = absolute;
    const tail = [];
    for (;;) {
        try {
            const real = realpath(current);
            return tail.length === 0 ? real : api.join(real, ...tail);
        }
        catch {
            const parent = api.dirname(current);
            if (parent === current)
                return absolute;
            tail.unshift(api.basename(current));
            current = parent;
        }
    }
}
/** True when `target` is `root` itself or lies below it. Both must be absolute. */
export function isWithin(root, target, platform = process.platform) {
    const api = pathApi(platform);
    let r = api.normalize(root);
    let t = api.normalize(target);
    if (isCaseInsensitive(platform)) {
        r = r.toLowerCase();
        t = t.toLowerCase();
    }
    const rel = api.relative(r, t);
    if (rel === '')
        return true;
    if (api.isAbsolute(rel))
        return false; // different drive / UNC share
    return rel !== '..' && !rel.startsWith(`..${api.sep}`);
}
/** True when `target` lies within any of `roots`. */
export function isWithinAny(roots, target, platform = process.platform) {
    return roots.some(root => isWithin(root, target, platform));
}
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
/**
 * Turn an arbitrary name into a file-name-safe key: ASCII letters, digits,
 * `-` and `_`, at most 48 characters, never a Windows reserved device name.
 */
export function safeKey(name) {
    let key = name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
    if (key === '')
        key = 'x';
    if (WINDOWS_RESERVED.test(key))
        key = `_${key}`;
    return key;
}
/** The Harness home: `$DSH_HOME`, else `~/.dsh`. */
export function dshHome(env = process.env, home = homeDir(env)) {
    return env['DSH_HOME'] !== undefined && env['DSH_HOME'] !== '' ? env['DSH_HOME'] : path.join(home, '.dsh');
}
/** The current user's home directory, honoring USERPROFILE on Windows. */
export function homeDir(env = process.env) {
    return env['USERPROFILE'] ?? env['HOME'] ?? process.cwd();
}
