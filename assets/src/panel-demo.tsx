// Renders the real ReviewPage with demo data for README screenshots.
import { createRoot } from 'react-dom/client'
import { ReviewPage } from '../../src/client/ReviewPage.tsx'
import { zh, en } from '../../src/client/locales.ts'

const params = new URLSearchParams(location.search)
const lang = params.get('lang') === 'en' ? 'en' : 'zh'
const dict: any = lang === 'en' ? en : zh
const t = (k: string) => dict[k] ?? k
const L = (a: string, b: string) => (lang === 'en' ? b : a)

const now = Date.now()
const ago = (min: number) => new Date(now - min * 60_000).toISOString()
const id = (n: number) => `session-${(n.toString(16) + 'a3f9c27e1b0d4e58').slice(0, 8)}-0000-4000-8000-000000000000`
const flash = { provider: 'deepseek-official', model: 'deepseek-flash' }
const pro = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
const kimi = { provider: 'moonshot', model: 'kimi-latest' }
const glm = { provider: 'zhipu', model: 'glm-latest' }
const relay = { provider: 'my-relay', model: 'qwen-coder' }

const batchA = L('claude · 解析器重构', 'claude · parser refactor')
const batchB = L('codex · 测试修复', 'codex · test fixes')
const batchC = L('kimi-code · 代码审查', 'kimi-code · review')
const S = (n: number, title: string, by: string, batch: string, chain: any[], state: string, min: number) =>
  ({ sessionId: id(n), title: `[${by}] ${title}`, createdBy: by, batch, chain, cwd: 'D:/work/my-app', createdAt: ago(min), state, taskCount: 2, desktop: 'active' })
const sessions = [
  S(1, L('实现 · 词法分析', 'implement · lexer'), 'claude', batchA, [flash, relay], 'running', 42),
  S(2, L('实现 · 语法树', 'implement · AST'), 'claude', batchA, [flash, relay], 'running', 42),
  S(3, L('实现 · 错误恢复', 'implement · error recovery'), 'claude', batchA, [relay, flash], 'running', 41),
  S(4, L('规划 · 模块拆分', 'plan · module split'), 'claude', batchA, [pro], 'idle', 44),
  S(5, L('基准 · 解析速度', 'bench · parse speed'), 'claude', batchA, [flash], 'queued', 40),
  S(6, L('修复 · 失败用例 1–7', 'fix · failing tests 1–7'), 'codex', batchB, [flash, glm], 'running', 25),
  S(7, L('修复 · 失败用例 8–14', 'fix · failing tests 8–14'), 'codex', batchB, [flash, glm], 'running', 25),
  S(8, L('修复 · 失败用例 15–20', 'fix · failing tests 15–20'), 'codex', batchB, [glm, flash], 'idle', 25),
  S(9, L('审查 · 解析器改动', 'review · parser changes'), 'kimi-code', batchC, [kimi, pro], 'running', 9),
  S(10, L('审查 · 测试修复', 'review · test fixes'), 'kimi-code', batchC, [kimi, pro], 'idle', 9),
]
const task = (n: number, s: number, title: string, status: string, min: number, extra: any = {}) =>
  ({ id: `task-${n}`, sessionId: id(s), title, status, resources: [], holds: [], createdAt: ago(min), startedAt: ago(min - 1), prompt: title, toolCalls: 12, ...extra })
const tasks = [
  task(1, 1, L('实现 token 流与位置信息', 'token stream with spans'), 'running', 30),
  task(2, 1, L('词法分析单元测试', 'lexer unit tests'), 'done', 41, { summary: { changes: L('新增 src/lexer.rs，38 个用例全部通过', 'added src/lexer.rs, 38 tests pass'), leftovers: '' } }),
  task(3, 2, L('AST 节点与访问器', 'AST nodes and visitor'), 'running', 28),
  task(4, 3, L('同步点错误恢复', 'error recovery at sync points'), 'waiting_approval', 20),
  task(5, 4, L('拆分 parser crate', 'split the parser crate'), 'done', 43, { summary: { changes: L('写出 PLAN.md：4 个模块、依赖顺序', 'wrote PLAN.md: 4 modules, dependency order'), leftovers: L('是否保留旧 API 需要你决定', 'keeping the old API needs your call') } }),
  task(6, 5, L('跑 cargo bench（独占机器）', 'run cargo bench (exclusive)'), 'waiting_resources', 12, { resources: ['bench'] }),
  task(7, 6, L('修复 7 个失败用例', 'fix 7 failing tests'), 'running', 20),
  task(8, 7, L('修复 7 个失败用例', 'fix 7 failing tests'), 'running', 20),
  task(9, 8, L('修复 6 个失败用例', 'fix 6 failing tests'), 'done', 24, { summary: { changes: L('6/6 通过；根因是时区假设', '6/6 pass; root cause was a timezone assumption'), leftovers: '' } }),
  task(10, 9, L('审查解析器改动', 'review parser changes'), 'running', 8),
  task(11, 10, L('审查测试修复', 'review test fixes'), 'done', 8, { summary: { changes: L('2 处建议，0 处阻断', '2 suggestions, 0 blockers'), leftovers: '' } }),
]
const approvals = [
  { id: 'ap-1', sessionId: id(3), tool: 'pwsh', rule: 'pip-install', reason: L('pip install 会从网络下载软件包', 'pip install downloads packages from the network'), summary: 'command: python -m pip install hypothesis==6.112.0', expiresAt: new Date(now + 13 * 60_000).toISOString() },
  { id: 'ap-2', sessionId: id(7), tool: 'pwsh', rule: 'network-read', reason: L('curl 会访问网络', 'curl reaches the network'), summary: 'command: curl -sL https://example.com/fixtures/tz.json -o tests/fixtures/tz.json', expiresAt: new Date(now + 9 * 60_000).toISOString() },
]
const P = (maxConcurrent: number, cap: number, inFlight: number, queued: number, circuit: string, ok: number, rl: number, ov: number, err: number) =>
  ({ maxConcurrent, cap, inFlight, queued, circuit, counts: { ok, rate_limited: rl, overloaded: ov, error: err } })
const providers = {
  'deepseek-official': P(8, 8, 7, 4, 'closed', 1284, 0, 1, 0),
  zhipu: P(4, 4, 2, 0, 'closed', 233, 0, 0, 0),
  moonshot: P(4, 4, 1, 0, 'closed', 141, 0, 0, 0),
  'my-relay': P(4, 1, 1, 2, 'half-open', 312, 9, 2, 0),
}
let seq = 0
const ev = (min: number, type: string, data: any) => ({ seq: ++seq, at: ago(min), type, data })
const gate = (min: number, s: number, tool: string, kind: string, rule: string, reason = '') => ev(min, 'gate/decision', { sessionId: id(s), root: id(s), tool, kind, rule, reason })
const events = [
  ev(45, 'routes/probed', { ok: 9, count: 10, failed: [{ route: 'my-relay/legacy-model', detail: '404 model not found' }], by: 'claude' }),
  gate(39, 1, 'pwsh', 'deny', 'credential-read', L('凭据文件永远不允许 worker 读取', 'credential files are never readable by workers')),
  gate(33, 2, 'write', 'deny', 'write-outside-root', L('写入目标在工作区之外', 'write target is outside the workspace roots')),
  gate(28, 6, 'pwsh', 'deny', 'git-remote', L('推送和修改远程仓库只能由驱动方执行', 'pushing or changing remotes is reserved to the orchestrator')),
  gate(22, 5, 'pwsh', 'deny', 'bench-lease', L('基准测试需要独占的 bench 锁', 'benchmark commands need the exclusive "bench" lease')),
  ev(18, 'route/switch', { from: 'my-relay/qwen-coder', to: 'deepseek-official/deepseek-flash', reason: L('熔断：连续 5 次 429', 'breaker open: 5× 429') }),
  gate(15, 7, 'pwsh', 'deny', 'acl', L('修改 ACL 属于环境问题：停下并报告', 'ACL changes are an environment issue: stop and report')),
  gate(12, 3, 'pwsh', 'escalate', 'pip-install', L('pip install 会从网络下载软件包', 'pip install downloads packages from the network')),
  ev(11, 'approval/settled', { tool: 'pwsh', result: L('批准 · claude', 'allow · claude') }),
  gate(10, 7, 'pwsh', 'escalate', 'network-read', L('curl 会访问网络', 'curl reaches the network')),
  ev(8, 'task/done', { taskId: 'task-11', summary: { changes: L('2 处建议，0 处阻断', '2 suggestions, 0 blockers') } }),
  gate(6, 9, 'pwsh', 'deny', 'env-dump', L('打印环境变量可能泄露 API key', 'printing environment variables can leak API keys')),
  ev(3, 'task/done', { taskId: 'task-9', summary: { changes: L('6/6 通过', '6/6 pass') } }),
]
const snapshot = {
  version: '0.1.1', now: new Date(now).toISOString(), workspaceRoots: ['D:/work/my-app'],
  limits: { maxSessions: 0, maxActiveSessions: 0, approvalTimeoutMs: 900000 },
  sessions, tasks, approvals,
  leases: [{ name: 'bench', holder: 'task-0', queued: 1 }],
  providers,
  usage: {
    'deepseek-official/deepseek-flash': { requests: 1102, inputTokens: '38.2M', outputTokens: '1.9M', cacheHitRate: 0.87 },
    'deepseek-official/deepseek-v4-pro': { requests: 183, inputTokens: '6.1M', outputTokens: '0.4M', cacheHitRate: 0.79 },
    'zhipu/glm-latest': { requests: 233, inputTokens: '7.0M', outputTokens: '0.3M', cacheHitRate: 0.64 },
    'moonshot/kimi-latest': { requests: 141, inputTokens: '5.2M', outputTokens: '0.2M', cacheHitRate: 0.71 },
  },
  routeHealth: { broken: { 'my-relay/legacy-model': { reason: '404 model not found', until: new Date(now + 25 * 60_000).toISOString() } } },
  events, cursor: seq, truncated: false,
}
let served = false
window.fetch = (async () => {
  const body = served ? { ...snapshot, events: [] } : snapshot
  served = true
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}) as any

createRoot(document.getElementById('root')!).render(
  <ReviewPage t={t as any} openSession={() => true} archiveSession={async () => {}} unarchiveSession={async () => {}} />,
)
const tab = Number(params.get('tab') ?? 0)
setTimeout(() => {
  const buttons = document.querySelectorAll('[role="tab"]')
  ;(buttons[tab] as HTMLElement | undefined)?.click()
  if (params.get('dialog') === '1') setTimeout(() => (document.querySelectorAll('button')[6] as HTMLElement)?.click(), 200)
}, 300)
