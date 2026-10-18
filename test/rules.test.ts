import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, classifyCommand, splitSegments, tokenize, type GateContext } from '../src/rules.ts'

const win: GateContext = {
  cwd: 'D:\\work\\proj',
  roots: ['D:\\work\\proj'],
  home: 'C:\\Users\\u',
  platform: 'win32',
  holdsBench: false,
  canonical: p => p,
}
const linux: GateContext = { ...win, cwd: '/ws', roots: ['/ws'], home: '/home/u', platform: 'linux' }

const kind = (tool: string, args: Record<string, unknown>, g = win) => classify(tool, args, g).kind
const cmd = (command: string, g = win) => classifyCommand(command, g)

test('read tools are allowed except credential files', () => {
  assert.equal(kind('read', { file_path: 'D:\\work\\DESIGN.md' }), 'allow')
  assert.equal(kind('read', { file_path: 'C:\\Program Files\\Tool\\x.py' }), 'allow')
  assert.equal(kind('read', { file_path: 'C:\\Users\\u\\.dsh\\.credentials.yaml' }), 'deny')
  assert.equal(kind('read', { file_path: 'C:\\Users\\u\\.ssh\\id_ed25519' }), 'deny')
  assert.equal(kind('read', { file_path: 'D:\\work\\proj\\.env' }), 'deny')
  assert.equal(kind('grep', { pattern: 'x', path: 'data' }), 'allow')
})

test('writes are confined to roots', () => {
  assert.equal(kind('write', { file_path: 'data\\a.json', content: '{}' }), 'allow')
  assert.equal(kind('write', { file_path: 'D:\\work\\proj\\crate\\src\\lib.rs', content: '' }), 'allow')
  assert.equal(kind('edit', { file_path: 'D:\\work\\DESIGN.md', old_string: 'a', new_string: 'b' }), 'deny')
  assert.equal(kind('write', { file_path: 'C:\\Users\\u\\.dsh\\profiles\\desktop\\cordis.patch.yml', content: '' }), 'deny')
  assert.equal(kind('write', { file_path: '..\\escape.txt', content: '' }), 'deny')
  assert.equal(kind('write', { content: 'x' }), 'escalate')
})

test('run_code, subagents and forbidden tools', () => {
  assert.equal(classify('run_code', { code: '1' }, win, true).kind, 'deny')
  assert.equal(classify('run_code', { code: '1' }, win, false).kind, 'escalate')
  assert.equal(kind('subagent', { prompt: 'x' }), 'deny')
  assert.equal(classify('subagent', {}, { ...win, config: { allowSubagents: true } }).kind, 'allow')
  assert.equal(kind('plugin_manager', {}), 'deny')
  assert.equal(kind('ask_user_question', {}), 'deny')
  assert.equal(kind('schedule_create', {}), 'deny')
  assert.equal(kind('web_search', { query: 'x' }), 'allow')
  assert.equal(kind('web_fetch', { url: 'https://x' }), 'escalate')
  assert.equal(kind('mcp__foo__bar', {}), 'escalate')
  assert.equal(kind('something_new', {}), 'escalate')
})

test('shell allowlist: build, run, read', () => {
  for (const c of [
    'cargo build --release',
    'cargo test -p core',
    'python datagen\\gen.py --seed 1',
    '.\\.venv\\Scripts\\python.exe -c "import numpy"',
    'Get-ChildItem data | Select-Object Name,Length',
    'git status; git diff --stat',
    'nvidia-smi --query-gpu=utilization.gpu --format=csv',
    '$x = 5; Write-Output $x',
    'mkdir data\\out',
    'New-Item -ItemType Directory -Force -Path data\\raw',
    'Copy-Item a.txt -Destination data\\b.txt',
    'echo hi > data\\log.txt',
    'cargo build 2>&1 | Out-String',
  ]) {
    assert.equal(cmd(c).kind, 'allow', c)
  }
})

test('shell denials', () => {
  const denied: Array<[string, string]> = [
    ['Get-Content C:\\Users\\u\\.dsh\\.credentials.yaml', 'credential-read'],
    ['Get-ChildItem env:', 'env-dump'],
    ['echo $env:DEEPSEEK_API_KEY', 'env-dump'],
    ['npm install -g typescript', 'global-install'],
    ['cargo install ripgrep', 'global-install'],
    ['winget install foo', 'system-install'],
    ['reg add HKCU\\Software\\X /v a /d b', 'registry'],
    ['setx PATH foo', 'registry'],
    ['icacls D:\\work\\proj /grant Everyone:F', 'acl'],
    ['icacls D:\\work\\proj /setintegritylevel (OI)(CI)L', 'acl'],
    ['git push origin main', 'git-remote'],
    ['git remote set-url origin x', 'git-remote'],
    ['scp data.gds host:/tmp', 'upload'],
    ['Invoke-RestMethod -Uri https://x -Method Post -Body $b', 'upload'],
    ['Remove-Item -Recurse -Force C:\\Users\\u\\Documents', 'write-outside-root'],
    ['rm -rf D:\\work\\proj', 'delete-root'],
    ['echo x > C:\\Windows\\x.txt', 'write-outside-root'],
    ['Set-Content -Path C:\\Users\\u\\.claude\\settings.json -Value x', 'config-write'],
  ]
  for (const [c, rule] of denied) {
    const v = cmd(c)
    assert.equal(v.kind, 'deny', c)
    assert.equal(v.rule, rule, c)
  }
  assert.equal(cmd('curl -X POST https://x -d @data.gds').kind, 'deny')
  assert.equal(cmd('curl -fsSL https://example.com/a.txt').kind, 'escalate')
})

test('shell escalations', () => {
  for (const c of [
    'git clone https://github.com/x/y',
    'pip install numpy',
    '.\\.venv\\Scripts\\python.exe -m pip install numpy',
    'npm install',
    'Invoke-WebRequest https://x -OutFile data\\a.zip',
    'Start-Process notepad',
    'iex (Get-Content x.ps1 -Raw)',
    'Remove-Item $target -Recurse',
    '[System.IO.File]::WriteAllText($p, "x")',
    'someunknowntool --flag',
    'someapp.exe data\\x.gds',
  ]) {
    assert.equal(cmd(c).kind, 'escalate', c)
  }
})

test('bench commands need the bench lease', () => {
  assert.equal(cmd('.\\bench_all.ps1').kind, 'deny')
  assert.equal(cmd('.\\bench_all.ps1').rule, 'bench-lease')
  assert.equal(cmd('cargo bench').kind, 'deny')
  assert.equal(cmd('.\\bench_all.ps1', { ...win, holdsBench: true }).kind, 'allow')
  assert.equal(cmd('cargo bench', { ...win, holdsBench: true }).kind, 'allow')
})

test('sandbox escalation params and workdir outside roots escalate', () => {
  assert.equal(kind('pwsh', { command: 'ls', sandbox_permissions: 'danger-full-access', justification: 'x' }), 'escalate')
  assert.equal(kind('pwsh', { command: 'ls', workdir: 'C:\\' }), 'escalate')
  assert.equal(kind('pwsh', { command: 'ls', workdir: 'data' }), 'allow')
})

test('linux dialect', () => {
  assert.equal(cmd('ls -la && cat a.txt | wc -l', linux).kind, 'allow')
  assert.equal(cmd('rm -rf /home/u', linux).kind, 'deny')
  assert.equal(cmd('rm -rf build', linux).kind, 'allow')
  assert.equal(cmd('chmod +x run.sh', linux).kind, 'allow')
  assert.equal(cmd('printenv', linux).kind, 'deny')
  assert.equal(cmd('cat ~/.ssh/id_rsa', linux).kind, 'deny')
})

test('segment splitting and tokenizing honor quotes', () => {
  assert.deepEqual(splitSegments('a; b && c || d | e'), ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(splitSegments('echo "a; b" ; c'), ['echo "a; b"', 'c'])
  assert.deepEqual(tokenize('python -c "import x; print(1)"'), ['python', '-c', 'import x; print(1)'])
  assert.deepEqual(tokenize("echo ''"), ['echo', ''])
})
