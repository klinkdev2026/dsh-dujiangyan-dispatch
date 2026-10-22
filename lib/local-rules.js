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
import { existsSync, readFileSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { canonicalPath, isWithinAny } from "./paths.js";
export const LOCAL_RULES_FILE = 'local-rules.json';
const LAYER_KEYS = new Set(['rules', 'hints', 'facts']);
const RULE_KEYS = new Set(['allowCommands', 'denyPatterns', 'benchPatterns', 'allowEnv', 'allowPrograms']);
const TOP_KEYS = new Set(['workspaces', 'aiApproval', 'quietMode', 'workspaceRoots']);
function checkTop(v) {
    const roots = v['workspaceRoots'];
    if (roots !== undefined) {
        if (!isStringList(roots))
            return 'local-rules.workspaceRoots: expected an array of absolute paths';
        for (const r of roots) {
            if (!/^([A-Za-z]:[\\/]|\/)/.test(r))
                return `local-rules.workspaceRoots: ${JSON.stringify(r)} is not an absolute path`;
            if (/^([A-Za-z]:)?[\\/]*$/.test(r))
                return `local-rules.workspaceRoots: ${JSON.stringify(r)} is a whole drive; give a project folder`;
        }
    }
    const ai = v['aiApproval'];
    if (ai !== undefined) {
        if (ai === null || typeof ai !== 'object' || Array.isArray(ai))
            return 'local-rules.aiApproval: expected an object';
        const a = ai;
        for (const key of Object.keys(a))
            if (!['enabled', 'judges', 'timeoutMs', 'maxPerSessionPer10Min', '$comment'].includes(key))
                return `local-rules.aiApproval: unknown key "${key}"`;
        if (a['enabled'] !== undefined && typeof a['enabled'] !== 'boolean')
            return 'local-rules.aiApproval.enabled: expected true or false';
        if (a['timeoutMs'] !== undefined && !(typeof a['timeoutMs'] === 'number' && a['timeoutMs'] > 0))
            return 'local-rules.aiApproval.timeoutMs: expected a positive number';
        if (a['maxPerSessionPer10Min'] !== undefined && !(Number.isInteger(a['maxPerSessionPer10Min']) && a['maxPerSessionPer10Min'] >= 0))
            return 'local-rules.aiApproval.maxPerSessionPer10Min: expected a non-negative integer';
        if (a['judges'] !== undefined) {
            const j = a['judges'];
            if (!Array.isArray(j) || j.length === 0 || !j.every(x => x !== null && typeof x === 'object' && typeof x['provider'] === 'string' && typeof x['model'] === 'string' && (x['effort'] === undefined || typeof x['effort'] === 'string'))) {
                return 'local-rules.aiApproval.judges: expected a non-empty array of { provider, model, effort? }';
            }
        }
    }
    const q = v['quietMode'];
    if (q !== undefined) {
        if (q === null || typeof q !== 'object' || Array.isArray(q))
            return 'local-rules.quietMode: expected an object';
        const m = q;
        for (const key of Object.keys(m))
            if (!['enabled', 'patterns', '$comment'].includes(key))
                return `local-rules.quietMode: unknown key "${key}"`;
        if (m['enabled'] !== undefined && typeof m['enabled'] !== 'boolean')
            return 'local-rules.quietMode.enabled: expected true or false';
        if (m['patterns'] !== undefined) {
            if (!Array.isArray(m['patterns']) || !m['patterns'].every(s => typeof s === 'string'))
                return 'local-rules.quietMode.patterns: expected an array of strings';
            for (const s of m['patterns']) {
                const bad = badRegex(s);
                if (bad !== undefined)
                    return `local-rules.quietMode.patterns: invalid regular expression ${JSON.stringify(s)}: ${bad}`;
            }
        }
    }
    return undefined;
}
/** Validate the parsed JSON; returns an error message or undefined. Regular expressions must compile. */
function checkLayer(value, where, allowWorkspaces) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return `${where}: expected an object`;
    for (const key of Object.keys(value)) {
        if (!LAYER_KEYS.has(key) && !(allowWorkspaces && TOP_KEYS.has(key)) && !(!allowWorkspaces && key === 'aiApproval') && key !== '$comment')
            return `${where}: unknown key "${key}"`;
    }
    const v = value;
    if (!allowWorkspaces && v['aiApproval'] !== undefined) {
        const a = v['aiApproval'];
        if (a === null || typeof a !== 'object' || Array.isArray(a))
            return `${where}.aiApproval: expected an object`;
        for (const key of Object.keys(a))
            if (key !== 'judges' && key !== '$comment')
                return `${where}.aiApproval: only "judges" can differ per workspace ("${key}")`;
        if (a['judges'] !== undefined && !(Array.isArray(a['judges']) && a['judges'].length > 0 && a['judges'].every(isJudgeShape)))
            return `${where}.aiApproval.judges: expected a non-empty array of { provider, model, effort? }`;
    }
    if (v['rules'] !== undefined) {
        const r = v['rules'];
        if (r === null || typeof r !== 'object' || Array.isArray(r))
            return `${where}.rules: expected an object`;
        for (const [key, list] of Object.entries(r)) {
            if (!RULE_KEYS.has(key))
                return `${where}.rules: unknown key "${key}"`;
            if (key === 'allowEnv' || key === 'allowPrograms') {
                const bad = key === 'allowEnv' ? checkAllowEnv(list) : checkAllowPrograms(list);
                if (bad !== undefined)
                    return `${where}.rules.${key}${bad}`;
                continue;
            }
            if (!Array.isArray(list) || !list.every(s => typeof s === 'string'))
                return `${where}.rules.${key}: expected an array of strings`;
            if (key !== 'allowCommands') {
                for (const s of list) {
                    const bad = badRegex(s);
                    if (bad !== undefined)
                        return `${where}.rules.${key}: invalid regular expression ${JSON.stringify(s)}: ${bad}`;
                }
            }
        }
    }
    if (v['hints'] !== undefined) {
        if (!Array.isArray(v['hints']))
            return `${where}.hints: expected an array`;
        for (const [i, h] of v['hints'].entries()) {
            const hint = h;
            if (hint === null || typeof hint !== 'object')
                return `${where}.hints[${i}]: expected an object`;
            if (typeof hint['match'] !== 'string' || hint['match'] === '')
                return `${where}.hints[${i}].match: expected a non-empty string`;
            if (typeof hint['reason'] !== 'string' || hint['reason'] === '')
                return `${where}.hints[${i}].reason: expected a non-empty string`;
            if (hint['tool'] !== undefined && typeof hint['tool'] !== 'string')
                return `${where}.hints[${i}].tool: expected a string`;
            const bad = badRegex(hint['match']);
            if (bad !== undefined)
                return `${where}.hints[${i}].match: invalid regular expression: ${bad}`;
        }
    }
    if (v['facts'] !== undefined && !(Array.isArray(v['facts']) && v['facts'].every(s => typeof s === 'string')))
        return `${where}.facts: expected an array of strings`;
    return undefined;
}
const isJudgeShape = (x) => {
    const o = x;
    return o !== null && typeof o === 'object' && typeof o['provider'] === 'string' && typeof o['model'] === 'string' && (o['effort'] === undefined || typeof o['effort'] === 'string');
};
const isStringList = (v) => Array.isArray(v) && v.every(s => typeof s === 'string' && s !== '');
/** `[{ name, prepend?, append?, values? }]`; returns an error suffix or undefined. */
function checkAllowEnv(list) {
    if (!Array.isArray(list))
        return ': expected an array of { name, prepend?, append?, values? }';
    for (const [i, e] of list.entries()) {
        if (e === null || typeof e !== 'object' || Array.isArray(e))
            return `[${i}]: expected an object`;
        const o = e;
        for (const key of Object.keys(o))
            if (!['name', 'prepend', 'append', 'values', '$comment'].includes(key))
                return `[${i}]: unknown key "${key}"`;
        if (typeof o['name'] !== 'string' || !/^[A-Za-z_]\w*$/.test(o['name']))
            return `[${i}].name: expected an environment variable name`;
        for (const key of ['prepend', 'append', 'values']) {
            if (o[key] !== undefined && !isStringList(o[key]))
                return `[${i}].${key}: expected an array of non-empty strings`;
        }
        if (o['prepend'] === undefined && o['append'] === undefined && o['values'] === undefined)
            return `[${i}]: give prepend, append or values`;
    }
    return undefined;
}
/** `[{ path, args?, scriptFlag? }]`; returns an error suffix or undefined. */
function checkAllowPrograms(list) {
    if (!Array.isArray(list))
        return ': expected an array of { path, args?, scriptFlag? }';
    for (const [i, e] of list.entries()) {
        if (e === null || typeof e !== 'object' || Array.isArray(e))
            return `[${i}]: expected an object`;
        const o = e;
        for (const key of Object.keys(o))
            if (!['path', 'args', 'scriptFlag', '$comment'].includes(key))
                return `[${i}]: unknown key "${key}"`;
        if (typeof o['path'] !== 'string' || !/^([A-Za-z]:[\\/]|\/)/.test(o['path']))
            return `[${i}].path: expected an absolute path`;
        if (o['args'] !== undefined) {
            if (typeof o['args'] !== 'string')
                return `[${i}].args: expected a regular expression string`;
            const bad = badRegex(o['args']);
            if (bad !== undefined)
                return `[${i}].args: invalid regular expression: ${bad}`;
        }
        if (o['scriptFlag'] !== undefined && (typeof o['scriptFlag'] !== 'string' || !/^-/.test(o['scriptFlag'])))
            return `[${i}].scriptFlag: expected a flag such as "-r"`;
    }
    return undefined;
}
function badRegex(source) {
    try {
        new RegExp(source, 'i');
        return undefined;
    }
    catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
}
export function parseLocalRules(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch (err) {
        return { ok: false, error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
    const top = checkLayer(value, 'local-rules', true) ?? checkTop(value);
    if (top !== undefined)
        return { ok: false, error: top };
    const ws = value['workspaces'];
    if (ws !== undefined) {
        if (ws === null || typeof ws !== 'object' || Array.isArray(ws))
            return { ok: false, error: 'local-rules.workspaces: expected an object keyed by root path' };
        for (const [root, layer] of Object.entries(ws)) {
            const err = checkLayer(layer, `local-rules.workspaces[${JSON.stringify(root)}]`, false);
            if (err !== undefined)
                return { ok: false, error: err };
        }
    }
    return { ok: true, value: value };
}
/** Both lists, in order, without exact repeats (the same pattern is often in the profile config and the file). */
function concat(a, b) {
    if (a === undefined && b === undefined)
        return undefined;
    const seen = new Set();
    return [...a ?? [], ...b ?? []].filter(x => {
        const key = JSON.stringify(x);
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
/** The base rule config with every layer's patterns appended (layers only add; they never remove a base rule). */
export function mergeRules(base, layers) {
    let out = base;
    for (const layer of layers) {
        const r = layer.rules;
        if (r === undefined)
            continue;
        const allowCommands = concat(out.allowCommands, r.allowCommands);
        const denyPatterns = concat(out.denyPatterns, r.denyPatterns);
        const benchPatterns = concat(out.benchPatterns, r.benchPatterns);
        const allowEnv = concat(out.allowEnv, r.allowEnv);
        const allowPrograms = concat(out.allowPrograms, r.allowPrograms);
        out = {
            ...out,
            ...allowEnv !== undefined ? { allowEnv } : {},
            ...allowPrograms !== undefined ? { allowPrograms } : {},
            ...allowCommands !== undefined ? { allowCommands } : {},
            ...denyPatterns !== undefined ? { denyPatterns } : {},
            ...benchPatterns !== undefined ? { benchPatterns } : {},
        };
    }
    return out;
}
export class LocalRules {
    file;
    current = {};
    present = false;
    loadedAt;
    lastError;
    lastErrorAt;
    watcher;
    timer;
    events;
    audit;
    base;
    home;
    constructor(deps) {
        this.file = path.join(deps.stateDir, LOCAL_RULES_FILE);
        this.home = deps.home ?? homedir();
        this.events = deps.events;
        this.audit = deps.audit;
        this.base = deps.base;
    }
    /** Re-read the file. A missing file means no personal rules; an invalid one keeps the last good version. */
    reload() {
        if (!existsSync(this.file)) {
            const changed = this.present;
            this.current = {};
            this.present = false;
            this.loadedAt = new Date().toISOString();
            this.lastError = undefined;
            if (changed)
                this.report('rules/reloaded', { file: this.file, present: false });
            return { ok: true, present: false };
        }
        let text;
        try {
            text = readFileSync(this.file, 'utf8');
        }
        catch (err) {
            return this.invalid(`cannot read the file: ${err instanceof Error ? err.message : String(err)}`);
        }
        const parsed = parseLocalRules(text.replace(/^﻿/, ''));
        if (!parsed.ok)
            return this.invalid(parsed.error);
        const unsafe = this.unsafeRoot(parsed.value.workspaceRoots ?? []);
        if (unsafe !== undefined)
            return this.invalid(unsafe);
        this.current = parsed.value;
        this.present = true;
        this.loadedAt = new Date().toISOString();
        this.lastError = undefined;
        this.report('rules/reloaded', { file: this.file, present: true, counts: counts(parsed.value) });
        return { ok: true, present: true };
    }
    /** Watch the data directory (the file may not exist yet); changes apply after a short debounce. */
    watch() {
        if (this.watcher !== undefined)
            return;
        try {
            this.watcher = watch(path.dirname(this.file), (_event, name) => {
                if (name !== null && name !== LOCAL_RULES_FILE)
                    return;
                if (this.timer !== undefined)
                    clearTimeout(this.timer);
                this.timer = setTimeout(() => {
                    this.timer = undefined;
                    this.reload();
                }, 200);
                this.timer.unref?.();
            });
            this.watcher.unref?.();
        }
        catch {
            // No watcher (e.g. unsupported filesystem): djy_rules_reload still works.
        }
    }
    close() {
        if (this.timer !== undefined)
            clearTimeout(this.timer);
        this.watcher?.close();
        this.watcher = undefined;
    }
    status() {
        return {
            file: this.file,
            present: this.present,
            ...this.loadedAt !== undefined ? { loadedAt: this.loadedAt } : {},
            ...this.lastError !== undefined ? { lastError: this.lastError, lastErrorAt: this.lastErrorAt } : {},
            content: this.current,
        };
    }
    /** The layers that apply to a working directory: the top level, then each workspace root that contains it. */
    layersFor(cwd, platform = process.platform) {
        const layers = [this.current];
        if (cwd !== undefined) {
            for (const [root, layer] of Object.entries(this.current.workspaces ?? {})) {
                if (isWithinAny([canonicalPath(root, platform)], canonicalPath(cwd, platform), platform))
                    layers.push(layer);
            }
        }
        return layers;
    }
    effective(cwd, platform = process.platform) {
        const layers = this.layersFor(cwd, platform);
        const hints = [];
        for (const layer of layers) {
            for (const h of layer.hints ?? []) {
                hints.push({ id: `hint:${hints.length + 1}`, re: new RegExp(h.match, 'i'), ...h.tool !== undefined ? { tool: h.tool } : {}, reason: h.reason });
            }
        }
        return {
            rules: mergeRules(this.base(), layers),
            hints,
            facts: layers.flatMap(l => l.facts ?? []),
        };
    }
    /** The file's extra workspace roots, canonical. */
    workspaceRoots(platform = process.platform) {
        return (this.current.workspaceRoots ?? []).map(r => canonicalPath(r, platform));
    }
    /**
     * A root that would put the home directory or the plugin data directory (rules, token) inside
     * the workers' reach; the gate also protects them, but such a root is never what was meant.
     */
    unsafeRoot(roots, platform = process.platform) {
        const guarded = [this.home, path.dirname(this.file)].map(p => canonicalPath(p, platform));
        const dataDir = guarded[1];
        for (const r of roots) {
            const root = canonicalPath(r, platform);
            if (guarded.some(g => isWithinAny([root], g, platform)) || isWithinAny([dataDir], root, platform))
                return `local-rules.workspaceRoots: ${JSON.stringify(r)} contains the home or plugin data directory; give a project folder`;
        }
        return undefined;
    }
    /** The judges of the most specific workspace layer containing `cwd` that names judges, if any. */
    workspaceJudges(cwd, platform = process.platform) {
        let best;
        for (const [root, layer] of Object.entries(this.current.workspaces ?? {})) {
            const judges = layer.aiApproval?.judges;
            if (judges === undefined)
                continue;
            const r = canonicalPath(root, platform);
            if (isWithinAny([r], canonicalPath(cwd, platform), platform) && (best === undefined || r.length > best.len))
                best = { len: r.length, judges };
        }
        return best?.judges;
    }
    /** The file's `aiApproval` overrides, if any. */
    aiApproval() {
        return this.current.aiApproval;
    }
    /** The file's `quietMode` overrides, if any. */
    quietMode() {
        return this.current.quietMode;
    }
    invalid(error) {
        this.lastError = error;
        this.lastErrorAt = new Date().toISOString();
        this.report('rules/invalid', { file: this.file, error, keeping: this.loadedAt ?? 'none' });
        return { ok: false, error };
    }
    report(type, data) {
        this.events.append(type, data);
        this.audit({ type, ...data });
    }
}
function counts(f) {
    const layers = [f, ...Object.values(f.workspaces ?? {})];
    const n = (pick) => layers.reduce((s, l) => s + (pick(l)?.length ?? 0), 0);
    return {
        workspaces: Object.keys(f.workspaces ?? {}).length,
        workspaceRoots: f.workspaceRoots?.length ?? 0,
        allowCommands: n(l => l.rules?.allowCommands),
        denyPatterns: n(l => l.rules?.denyPatterns),
        benchPatterns: n(l => l.rules?.benchPatterns),
        hints: n(l => l.hints),
        facts: n(l => l.facts),
    };
}
/** The text a hint is matched against: the shell command, else the arguments as JSON (both also with `/` for `\`). */
export function hintSubject(args) {
    const command = args['command'];
    return typeof command === 'string' ? command : JSON.stringify(args);
}
export function matchHint(rules, tool, args) {
    const subject = hintSubject(args);
    const slashed = subject.replace(/\\/g, '/');
    return rules.hints.find(h => (h.tool === undefined || h.tool === tool) && (h.re.test(subject) || h.re.test(slashed)));
}
