/**
 * The slice of the DeepSeek Harness host this plugin touches, typed
 * structurally. The host services are injected by Cordis at runtime; keeping
 * these shapes local avoids compiling against a dozen host packages whose
 * private details change between release candidates. Every member used here
 * was checked against deepseek-harness 0.2.1-rc.2 (commit 687f282).
 */
/** Read an optional host service without throwing when it is absent. */
export function optional(ctx, name) {
    try {
        return (ctx.get(name) ?? undefined);
    }
    catch {
        return undefined;
    }
}
