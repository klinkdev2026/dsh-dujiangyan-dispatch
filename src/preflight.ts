/**
 * Workspace preflight: find environment problems before a worker trips over
 * them mid-task (and starts "repairing" ACLs on its own).
 *
 * Windows, `workspace-write`: the sandbox runs commands at Low integrity, so a
 * directory is writable only if it carries a Low mandatory label. Harness
 * labels the workspace root with an inheritable label, but directories that
 * already existed before that (e.g. created by another tool) keep their own
 * Medium label, so a pre-existing subdirectory of a labeled root is not
 * writable by the sandboxed worker.
 *
 * This module only reads (`icacls <dir>` prints the label without privileges);
 * repairs are the orchestrator's decision.
 */
import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'

export interface PreflightIssue {
  readonly path: string
  readonly problem: string
  /** A suggested repair confined to the workspace; never run automatically. */
  readonly suggestion?: string
}

const SKIP = new Set(['node_modules', '.git', 'target', '.venv', 'venv', '__pycache__', '.agent-teams'])

function icacls(dir: string): Promise<string> {
  return new Promise(resolve => {
    execFile('icacls', [dir], { windowsHide: true, timeout: 10_000 }, (err, stdout) => resolve(err === null ? stdout : ''))
  })
}

/** True when an `icacls` listing carries a Low mandatory label (inheritable or explicit). */
export function hasLowLabel(listing: string): boolean {
  return /Mandatory Label\\Low Mandatory Level/i.test(listing)
}

function listDirs(root: string, maxDepth: number, maxDirs: number): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || out.length >= maxDirs) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink() || SKIP.has(e.name)) continue
      const full = path.join(dir, e.name)
      out.push(full)
      if (out.length >= maxDirs) return
      walk(full, depth + 1)
    }
  }
  walk(root, 1)
  return out
}

export async function preflightWorkspace(
  cwd: string,
  permissionPreset: string,
  platform: NodeJS.Platform = process.platform,
  run: (dir: string) => Promise<string> = icacls,
): Promise<PreflightIssue[]> {
  if (platform !== 'win32' || permissionPreset !== 'workspace-write') return []
  // The working directory itself first: one created outside the sandbox (by the orchestrator, or by
  // an older session) is the common case (findings 45, 52).
  const dirs = [cwd, ...listDirs(cwd, 3, 200)]
  const issues: PreflightIssue[] = []
  for (let i = 0; i < dirs.length; i += 8) {
    const batch = dirs.slice(i, i + 8)
    const listings = await Promise.all(batch.map(run))
    batch.forEach((dir, j) => {
      const listing = listings[j] ?? ''
      if (listing !== '' && !hasLowLabel(listing)) {
        issues.push({
          path: dir,
          problem: 'directory has no Low integrity label; sandboxed workers (Low integrity) cannot write here',
          suggestion: `icacls "${dir}" /setintegritylevel (OI)(CI)L`,
        })
      }
    })
  }
  return issues
}
