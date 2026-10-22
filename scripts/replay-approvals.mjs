#!/usr/bin/env node
/**
 * Replay recorded approvals against the current gate rules.
 *
 *   node --experimental-strip-types scripts/replay-approvals.mjs --events <events.jsonl> --roots <dir>[,<dir>...]
 *        [--rules <local-rules.json>] [--from <ISO>] [--to <ISO>] [--platform win32|linux|darwin] [--home <dir>] [--json]
 *
 * Every `approval/pending` event in the window is classified again with the rules in src/ (and the
 * personal rules file, if given). The report says how many calls would still wait for an approver,
 * grouped by the rule that escalated them then and now. Bench-lease state is not recorded, so calls
 * are replayed as if the session holds no lease.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { classify } from '../src/rules.ts'
import { LocalRules, matchHint } from '../src/local-rules.ts'

const { values: opt } = parseArgs({
  options: {
    events: { type: 'string' },
    roots: { type: 'string' },
    rules: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    platform: { type: 'string' },
    home: { type: 'string' },
    json: { type: 'boolean' },
  },
})
if (opt.events === undefined || opt.roots === undefined) {
  console.error('usage: replay-approvals.mjs --events <events.jsonl> --roots <dir>[,<dir>...] [--rules <local-rules.json>] [--from <ISO>] [--to <ISO>]')
  process.exit(2)
}

const platform = opt.platform ?? process.platform
const roots = opt.roots.split(',').map(s => s.trim()).filter(Boolean)
const home = opt.home ?? homedir()

let local
let scratch
if (opt.rules !== undefined) {
  scratch = mkdtempSync(path.join(tmpdir(), 'djy-replay-'))
  copyFileSync(opt.rules, path.join(scratch, 'local-rules.json'))
  local = new LocalRules({ stateDir: scratch, events: { append() {} }, audit() {}, base: () => ({}) })
  const loaded = local.reload()
  if (!loaded.ok) {
    console.error(`local rules rejected: ${loaded.error}`)
    process.exit(1)
  }
}

const events = readFileSync(opt.events, 'utf8').split('\n').flatMap(line => {
  try {
    return line.trim() === '' ? [] : [JSON.parse(line)]
  } catch {
    return []
  }
})
const pending = events.filter(e => e.type === 'approval/pending'
  && (opt.from === undefined || e.at >= opt.from) && (opt.to === undefined || e.at <= opt.to))

const rows = []
for (const e of pending) {
  const d = e.data ?? {}
  if (d.origin === 'sandbox') {
    rows.push({ at: e.at, before: d.rule, after: d.rule, kind: 'escalate', note: 'host sandbox escalation (not replayable)' })
    continue
  }
  let args
  try {
    args = JSON.parse(d.summary)
  } catch {
    rows.push({ at: e.at, before: d.rule, after: 'unparsed-summary', kind: 'escalate' })
    continue
  }
  if (d.truncated === true) {
    rows.push({ at: e.at, before: d.rule, after: 'truncated-summary', kind: 'escalate' })
    continue
  }
  const cwd = d.cwd !== undefined && d.cwd !== '' ? d.cwd : roots[0]
  const effective = local?.effective(cwd, platform)
  const ctx = {
    cwd, roots, home, platform, holdsBench: false,
    config: effective?.rules ?? {},
    canonical: p => p,
    // Dot-sourced scripts are read as they are now (they may have changed since the call).
    readScript: p => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return undefined
      }
    },
  }
  let verdict
  try {
    verdict = classify(d.tool, args, ctx, false)
  } catch (err) {
    verdict = { kind: 'escalate', rule: 'classifier-error', reason: String(err) }
  }
  if (verdict.kind === 'escalate' && effective !== undefined) {
    const hint = matchHint(effective, d.tool, args)
    if (hint !== undefined) verdict = { kind: 'deny', rule: hint.id, reason: hint.reason }
  }
  const command = typeof args.command === 'string' ? args.command : JSON.stringify(args)
  rows.push({ at: e.at, before: d.rule, after: verdict.rule, kind: verdict.kind, reason: verdict.reason, command })
}
if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true })

const still = rows.filter(r => r.kind === 'escalate')
const tally = (list, key) => {
  const out = {}
  for (const r of list) out[r[key]] = (out[r[key]] ?? 0) + 1
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]))
}
const report = {
  window: { from: opt.from ?? null, to: opt.to ?? null },
  total: rows.length,
  nowAllowed: rows.filter(r => r.kind === 'allow').length,
  nowDenied: rows.filter(r => r.kind === 'deny').length,
  stillEscalated: still.length,
  before: tally(rows, 'before'),
  stillByRule: tally(still, 'after'),
  denied: rows.filter(r => r.kind === 'deny').map(r => ({ at: r.at, rule: r.after, command: r.command?.slice(0, 200) })),
  still: still.map(r => ({ at: r.at, before: r.before, after: r.after, reason: r.reason?.slice(0, 160), command: r.command?.replace(/\s+/g, ' ').slice(0, 240) })),
}
if (opt.json === true) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`approvals replayed: ${report.total}  now allowed: ${report.nowAllowed}  now denied: ${report.nowDenied}  still waiting for an approver: ${report.stillEscalated}`)
  console.log('recorded rules:', report.before)
  console.log('still escalated by rule:', report.stillByRule)
  for (const r of report.denied) console.log(`  DENY ${r.at} ${r.rule}: ${r.command}`)
  for (const r of report.still) console.log(`  ${r.at} ${r.before} -> ${r.after}: ${r.command}`)
}
