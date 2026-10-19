/**
 * Personal, hot-reloaded gate rules: `<stateDir>/local-rules.json`.
 *
 * The profile config is the stable base; this file holds what one user learns
 * while running their own projects (extra allow/deny/bench patterns, "hints"
 * that turn a known-wrong escalation into a deny with the right advice, extra
 * environment facts), optionally scoped to a workspace root. It is re-read on
 * change without restarting the host. An invalid file never reaches the gate:
 * the last good version stays in force and the error is reported.
 *
 * The file lives in the plugin data directory, outside every workspace root,
 * and the gate denies worker writes there, so workers cannot loosen their own
 * rules.
 */
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { EventLog } from './events.ts'
import { canonicalPath, isWithinAny } from './paths.ts'
import type { RuleConfig } from './rules.ts'

export const LOCAL_RULES_FILE = 'local-rules.json'

export interface Hint {
  /** Regular expression (case-insensitive) tested against the call text (the shell command, or the tool arguments as JSON). */
  readonly match: string
  /** Only for this tool (e.g. `pwsh`); any tool when absent. */
  readonly tool?: string
  /** The deny reason the worker receives. */
  readonly reason: string
}

export interface RuleLayer {
  readonly rules?: Pick<RuleConfig, 'allowCommands' | 'denyPatterns' | 'benchPatterns'>
  readonly hints?: readonly Hint[]
  readonly facts?: readonly string[]
}

export interface LocalRulesFile extends RuleLayer {
  /** Layers applied only to sessions whose working directory is inside the given root. */
  readonly workspaces?: Readonly<Record<string, RuleLayer>>
  /** Overrides of the profile `aiApproval` setting (top level only). */
  readonly aiApproval?: { readonly enabled?: boolean; readonly judges?: ReadonlyArray<{ provider: string; model: string; effort?: string }>; readonly timeoutMs?: number; readonly maxPerSessionPer10Min?: number }
  /** Overrides of the profile `quietMode` setting (top level only); patterns are added to the profile ones. */
  readonly quietMode?: { readonly enabled?: boolean; readonly patterns?: readonly string[] }
}

export interface EffectiveRules {
  readonly rules: RuleConfig
  readonly hints: ReadonlyArray<{ readonly id: string; readonly re: RegExp; readonly tool?: string; readonly reason: string }>
  readonly facts: readonly string[]
}

const LAYER_KEYS = new Set(['rules', 'hints', 'facts'])
const RULE_KEYS = new Set(['allowCommands', 'denyPatterns', 'benchPatterns'])
const TOP_KEYS = new Set(['workspaces', 'aiApproval', 'quietMode'])

function checkTop(v: Record<string, unknown>): string | undefined {
  const ai = v['aiApproval']
  if (ai !== undefined) {
    if (ai === null || typeof ai !== 'object' || Array.isArray(ai)) return 'local-rules.aiApproval: expected an object'
    const a = ai as Record<string, unknown>
    for (const key of Object.keys(a)) if (!['enabled', 'judges', 'timeoutMs', 'maxPerSessionPer10Min', '$comment'].includes(key)) return `local-rules.aiApproval: unknown key "${key}"`
    if (a['enabled'] !== undefined && typeof a['enabled'] !== 'boolean') return 'local-rules.aiApproval.enabled: expected true or false'
    if (a['timeoutMs'] !== undefined && !(typeof a['timeoutMs'] === 'number' && a['timeoutMs'] > 0)) return 'local-rules.aiApproval.timeoutMs: expected a positive number'
    if (a['maxPerSessionPer10Min'] !== undefined && !(Number.isInteger(a['maxPerSessionPer10Min']) && (a['maxPerSessionPer10Min'] as number) >= 0)) return 'local-rules.aiApproval.maxPerSessionPer10Min: expected a non-negative integer'
    if (a['judges'] !== undefined) {
      const j = a['judges']
      if (!Array.isArray(j) || j.length === 0 || !j.every(x => x !== null && typeof x === 'object' && typeof (x as Record<string, unknown>)['provider'] === 'string' && typeof (x as Record<string, unknown>)['model'] === 'string' && ((x as Record<string, unknown>)['effort'] === undefined || typeof (x as Record<string, unknown>)['effort'] === 'string'))) {
        return 'local-rules.aiApproval.judges: expected a non-empty array of { provider, model, effort? }'
      }
    }
  }
  const q = v['quietMode']
  if (q !== undefined) {
    if (q === null || typeof q !== 'object' || Array.isArray(q)) return 'local-rules.quietMode: expected an object'
    const m = q as Record<string, unknown>
    for (const key of Object.keys(m)) if (!['enabled', 'patterns', '$comment'].includes(key)) return `local-rules.quietMode: unknown key "${key}"`
    if (m['enabled'] !== undefined && typeof m['enabled'] !== 'boolean') return 'local-rules.quietMode.enabled: expected true or false'
    if (m['patterns'] !== undefined) {
      if (!Array.isArray(m['patterns']) || !(m['patterns'] as unknown[]).every(s => typeof s === 'string')) return 'local-rules.quietMode.patterns: expected an array of strings'
      for (const s of m['patterns'] as string[]) {
        const bad = badRegex(s)
        if (bad !== undefined) return `local-rules.quietMode.patterns: invalid regular expression ${JSON.stringify(s)}: ${bad}`
      }
    }
  }
  return undefined
}

/** Validate the parsed JSON; returns an error message or undefined. Regular expressions must compile. */
function checkLayer(value: unknown, where: string, allowWorkspaces: boolean): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return `${where}: expected an object`
  for (const key of Object.keys(value)) {
    if (!LAYER_KEYS.has(key) && !(allowWorkspaces && TOP_KEYS.has(key)) && key !== '$comment') return `${where}: unknown key "${key}"`
  }
  const v = value as Record<string, unknown>
  if (v['rules'] !== undefined) {
    const r = v['rules']
    if (r === null || typeof r !== 'object' || Array.isArray(r)) return `${where}.rules: expected an object`
    for (const [key, list] of Object.entries(r)) {
      if (!RULE_KEYS.has(key)) return `${where}.rules: unknown key "${key}"`
      if (!Array.isArray(list) || !list.every(s => typeof s === 'string')) return `${where}.rules.${key}: expected an array of strings`
      if (key !== 'allowCommands') {
        for (const s of list as string[]) {
          const bad = badRegex(s)
          if (bad !== undefined) return `${where}.rules.${key}: invalid regular expression ${JSON.stringify(s)}: ${bad}`
        }
      }
    }
  }
  if (v['hints'] !== undefined) {
    if (!Array.isArray(v['hints'])) return `${where}.hints: expected an array`
    for (const [i, h] of (v['hints'] as unknown[]).entries()) {
      const hint = h as Record<string, unknown>
      if (hint === null || typeof hint !== 'object') return `${where}.hints[${i}]: expected an object`
      if (typeof hint['match'] !== 'string' || hint['match'] === '') return `${where}.hints[${i}].match: expected a non-empty string`
      if (typeof hint['reason'] !== 'string' || hint['reason'] === '') return `${where}.hints[${i}].reason: expected a non-empty string`
      if (hint['tool'] !== undefined && typeof hint['tool'] !== 'string') return `${where}.hints[${i}].tool: expected a string`
      const bad = badRegex(hint['match'])
      if (bad !== undefined) return `${where}.hints[${i}].match: invalid regular expression: ${bad}`
    }
  }
  if (v['facts'] !== undefined && !(Array.isArray(v['facts']) && v['facts'].every(s => typeof s === 'string'))) return `${where}.facts: expected an array of strings`
  return undefined
}

function badRegex(source: string): string | undefined {
  try {
    new RegExp(source, 'i')
    return undefined
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

export function parseLocalRules(text: string): { ok: true; value: LocalRulesFile } | { ok: false; error: string } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  const top = checkLayer(value, 'local-rules', true) ?? checkTop(value as Record<string, unknown>)
  if (top !== undefined) return { ok: false, error: top }
  const ws = (value as Record<string, unknown>)['workspaces']
  if (ws !== undefined) {
    if (ws === null || typeof ws !== 'object' || Array.isArray(ws)) return { ok: false, error: 'local-rules.workspaces: expected an object keyed by root path' }
    for (const [root, layer] of Object.entries(ws)) {
      const err = checkLayer(layer, `local-rules.workspaces[${JSON.stringify(root)}]`, false)
      if (err !== undefined) return { ok: false, error: err }
    }
  }
  return { ok: true, value: value as LocalRulesFile }
}

const concat = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
  a === undefined && b === undefined ? undefined : [...a ?? [], ...b ?? []]

/** The base rule config with every layer's patterns appended (layers only add; they never remove a base rule). */
export function mergeRules(base: RuleConfig, layers: readonly RuleLayer[]): RuleConfig {
  let out: RuleConfig = base
  for (const layer of layers) {
    const r = layer.rules
    if (r === undefined) continue
    const allowCommands = concat(out.allowCommands, r.allowCommands)
    const denyPatterns = concat(out.denyPatterns, r.denyPatterns)
    const benchPatterns = concat(out.benchPatterns, r.benchPatterns)
    out = {
      ...out,
      ...allowCommands !== undefined ? { allowCommands } : {},
      ...denyPatterns !== undefined ? { denyPatterns } : {},
      ...benchPatterns !== undefined ? { benchPatterns } : {},
    }
  }
  return out
}

export interface LocalRulesStatus {
  readonly file: string
  readonly present: boolean
  readonly loadedAt?: string
  readonly lastError?: string
  readonly lastErrorAt?: string
  readonly content: LocalRulesFile
}

export class LocalRules {
  readonly file: string
  private current: LocalRulesFile = {}
  private present = false
  private loadedAt: string | undefined
  private lastError: string | undefined
  private lastErrorAt: string | undefined
  private watcher: FSWatcher | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly events: EventLog
  private readonly audit: (record: Record<string, unknown>) => void
  private readonly base: () => RuleConfig

  constructor(deps: { stateDir: string; events: EventLog; audit: (record: Record<string, unknown>) => void; base: () => RuleConfig }) {
    this.file = path.join(deps.stateDir, LOCAL_RULES_FILE)
    this.events = deps.events
    this.audit = deps.audit
    this.base = deps.base
  }

  /** Re-read the file. A missing file means no personal rules; an invalid one keeps the last good version. */
  reload(): { ok: true; present: boolean } | { ok: false; error: string } {
    if (!existsSync(this.file)) {
      const changed = this.present
      this.current = {}
      this.present = false
      this.loadedAt = new Date().toISOString()
      this.lastError = undefined
      if (changed) this.report('rules/reloaded', { file: this.file, present: false })
      return { ok: true, present: false }
    }
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch (err) {
      return this.invalid(`cannot read the file: ${err instanceof Error ? err.message : String(err)}`)
    }
    const parsed = parseLocalRules(text.replace(/^﻿/, ''))
    if (!parsed.ok) return this.invalid(parsed.error)
    this.current = parsed.value
    this.present = true
    this.loadedAt = new Date().toISOString()
    this.lastError = undefined
    this.report('rules/reloaded', { file: this.file, present: true, counts: counts(parsed.value) })
    return { ok: true, present: true }
  }

  /** Watch the data directory (the file may not exist yet); changes apply after a short debounce. */
  watch(): void {
    if (this.watcher !== undefined) return
    try {
      this.watcher = watch(path.dirname(this.file), (_event, name) => {
        if (name !== null && name !== LOCAL_RULES_FILE) return
        if (this.timer !== undefined) clearTimeout(this.timer)
        this.timer = setTimeout(() => {
          this.timer = undefined
          this.reload()
        }, 200)
        this.timer.unref?.()
      })
      this.watcher.unref?.()
    } catch {
      // No watcher (e.g. unsupported filesystem): djy_rules_reload still works.
    }
  }

  close(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.watcher?.close()
    this.watcher = undefined
  }

  status(): LocalRulesStatus {
    return {
      file: this.file,
      present: this.present,
      ...this.loadedAt !== undefined ? { loadedAt: this.loadedAt } : {},
      ...this.lastError !== undefined ? { lastError: this.lastError, lastErrorAt: this.lastErrorAt } : {},
      content: this.current,
    }
  }

  /** The layers that apply to a working directory: the top level, then each workspace root that contains it. */
  layersFor(cwd: string | undefined, platform: NodeJS.Platform = process.platform): RuleLayer[] {
    const layers: RuleLayer[] = [this.current]
    if (cwd !== undefined) {
      for (const [root, layer] of Object.entries(this.current.workspaces ?? {})) {
        if (isWithinAny([canonicalPath(root, platform)], canonicalPath(cwd, platform), platform)) layers.push(layer)
      }
    }
    return layers
  }

  effective(cwd: string | undefined, platform: NodeJS.Platform = process.platform): EffectiveRules {
    const layers = this.layersFor(cwd, platform)
    const hints: Array<EffectiveRules['hints'][number]> = []
    for (const layer of layers) {
      for (const h of layer.hints ?? []) {
        hints.push({ id: `hint:${hints.length + 1}`, re: new RegExp(h.match, 'i'), ...h.tool !== undefined ? { tool: h.tool } : {}, reason: h.reason })
      }
    }
    return {
      rules: mergeRules(this.base(), layers),
      hints,
      facts: layers.flatMap(l => l.facts ?? []),
    }
  }

  /** The file's `aiApproval` overrides, if any. */
  aiApproval(): LocalRulesFile['aiApproval'] {
    return this.current.aiApproval
  }

  /** The file's `quietMode` overrides, if any. */
  quietMode(): LocalRulesFile['quietMode'] {
    return this.current.quietMode
  }

  private invalid(error: string): { ok: false; error: string } {
    this.lastError = error
    this.lastErrorAt = new Date().toISOString()
    this.report('rules/invalid', { file: this.file, error, keeping: this.loadedAt ?? 'none' })
    return { ok: false, error }
  }

  private report(type: string, data: Record<string, unknown>): void {
    this.events.append(type, data)
    this.audit({ type, ...data })
  }
}

function counts(f: LocalRulesFile): Record<string, number> {
  const layers: RuleLayer[] = [f, ...Object.values(f.workspaces ?? {})]
  const n = (pick: (l: RuleLayer) => readonly unknown[] | undefined) => layers.reduce((s, l) => s + (pick(l)?.length ?? 0), 0)
  return {
    workspaces: Object.keys(f.workspaces ?? {}).length,
    allowCommands: n(l => l.rules?.allowCommands),
    denyPatterns: n(l => l.rules?.denyPatterns),
    benchPatterns: n(l => l.rules?.benchPatterns),
    hints: n(l => l.hints),
    facts: n(l => l.facts),
  }
}

/** The text a hint is matched against: the shell command, else the arguments as JSON (both also with `/` for `\`). */
export function hintSubject(args: Readonly<Record<string, unknown>>): string {
  const command = args['command']
  return typeof command === 'string' ? command : JSON.stringify(args)
}

export function matchHint(rules: EffectiveRules, tool: string, args: Readonly<Record<string, unknown>>): EffectiveRules['hints'][number] | undefined {
  const subject = hintSubject(args)
  const slashed = subject.replace(/\\/g, '/')
  return rules.hints.find(h => (h.tool === undefined || h.tool === tool) && (h.re.test(subject) || h.re.test(slashed)))
}
