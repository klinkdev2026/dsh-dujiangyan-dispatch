/**
 * Environment facts for workers: things a sandboxed worker would otherwise
 * discover by trial and error (each probe being a gated call an approver has
 * to answer). Measured values are labeled as measured; the rest are known
 * properties of the Harness sandbox, stated as such.
 */
import { statfsSync } from 'node:fs';
export function measureFacts(roots, permissionPreset, platform = process.platform) {
    return {
        freeBytes: roots.map(root => {
            try {
                const s = statfsSync(root);
                return { root, free: Number(s.bavail) * Number(s.bsize) };
            }
            catch {
                return { root, free: undefined };
            }
        }),
        platform,
        permissionPreset,
    };
}
const gb = (n) => `${(n / 1024 ** 3).toFixed(1)} GB`;
/** The short "Environment facts" block appended to a task prompt. */
export function describeFacts(f, extra = []) {
    const lines = ['[dujiangyan] Environment facts (no need to probe these):'];
    const disks = f.freeBytes.filter(d => d.free !== undefined).map(d => `${d.root} ${gb(d.free)} free`);
    if (disks.length > 0)
        lines.push(`- Disk, measured at task start: ${disks.join('; ')}.`);
    if (f.platform === 'win32' && f.permissionPreset === 'workspace-write') {
        lines.push('- Known behaviour of the Windows sandbox: HTTPS through the Windows TLS stack (Schannel: curl.exe, cargo, git, Invoke-WebRequest) fails with SEC_E_NO_CREDENTIALS; Python and Node HTTPS (OpenSSL) and plain HTTP work. Do not test connectivity.', '- Named pipes cannot be opened inside the sandbox; record that as an observation instead of retrying with other options.', '- So package managers that use the Windows TLS stack (cargo, git over HTTPS) cannot download here: dependencies have to be fetched outside the sandbox (ask for it in your reply), then build offline (e.g. `cargo build --offline`).');
    }
    lines.push('- If a dependency is missing, do not work around it: finish the task and list exactly what needs fetching (Cargo.toml / package names).');
    for (const fact of extra)
        lines.push(`- ${fact}`);
    return lines.join('\n');
}
