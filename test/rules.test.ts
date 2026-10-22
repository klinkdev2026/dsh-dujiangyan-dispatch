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

// ── regression: commands from a real dispatch run that escalated needlessly, plus a hidden-danger
// variant for every pattern the parser now accepts ─────────────────────────────────────────────

const HERE_CODE = "Add-Content -Path 'D:/work/proj/src/win.rs' -Encoding utf8 -Value @'\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() { assert!(1 > 0); }\n}\n'@"

test('real-run commands are recognized (no approval needed)', () => {
  for (const c of [
    // computed properties in Select-Object
    "Get-PSDrive D,C | Select-Object Name,@{n='FreeGB';e={[math]::Round($_.Free/1GB,1)}} | Format-Table",
    "Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,@{n='SizeGB';e={[math]::Round($_.Size/1GB,2)}},@{n='FreeGB';e={[math]::Round($_.FreeSpace/1GB,2)}} | Format-Table -AutoSize",
    // compact assignments, then use of the variable
    "$env:CARGO_TARGET_DIR='D:/work/proj/target'; cargo build --offline 2>&1 | Select-Object -Last 60",
    "$p='D:/work/proj/results/smoke/a.jsonl'; Get-Content $p -TotalCount 3; Select-String -Path $p -Pattern '\"kind\":\"query\"' | Select-Object -First 2 | ForEach-Object Line",
    "$p='D:/work/proj/src/main.rs'; $s=Get-Content $p -Raw; $s=$s.Replace('emit(rec, i,', 'emit(rec, \"small\", i,'); Set-Content $p -Value $s -Encoding utf8",
    "$root='D:/work/proj/s09'; New-Item -ItemType Directory -Force -Path \"$root/crates/core/src\",\"$root/results/raw\" | Out-Null; Get-ChildItem $root | Select-Object Name",
    // format strings and subexpressions
    'Get-ChildItem D:/work/proj/src/*.rs | ForEach-Object { $n=(Get-Content $_.FullName | Measure-Object -Line).Lines; "{0,-40} {1,6}" -f $_.Name,$n }',
    "rustc --version; cargo --version; (Get-ItemProperty 'HKLM:\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0').ProcessorNameString; Write-Output \"logical_cores=$([Environment]::ProcessorCount)\"; powercfg /getactivescheme 2>&1",
    // nested shells
    'cmd /c "cargo test --offline --manifest-path D:\\work\\proj\\Cargo.toml --lib 2>&1"',
    'cmd.exe /c "cargo test --offline > D:\\work\\proj\\results\\logs\\cargo_test.log 2>&1"; Write-Output "test_exit=$LASTEXITCODE"',
    'pwsh -NoProfile -ExecutionPolicy Bypass -File D:/work/proj/tools/smoke.ps1 2>&1',
    // workspace executables through a variable, loops, control flow without spaces
    "$m='D:/work/proj/target/release/measure.exe'; $s='D:/work/proj/results/smoke'; & $m --mode query --n 1000 --out \"$s/q.jsonl\"; Write-Output \"exit1=$LASTEXITCODE\"",
    "$cli='D:/work/proj/target/debug/client.exe'; foreach($ch in @('NDJSON-P','MP-P')) { Write-Output \"=== $ch ===\"; & $cli small --channel $ch --count 100 2>&1 | Select-Object -Last 3 }",
    "$root='D:/work/proj'; $exe='D:/work/proj/target/release/m.exe'; foreach ($n in @('a','b')) { & $exe --file \"D:/work/data/$n.gds\" --jsonl \"$root/results/raw/$n.jsonl\" | Out-Null; if ($LASTEXITCODE -ne 0) { throw \"verify failed: $n\" } }",
    "$py='D:/work/py/python.exe'; if(-not (Test-Path 'D:/work/proj/.venv/Scripts/python.exe')){ & $py -m venv 'D:/work/proj/.venv' --system-site-packages }; & 'D:/work/proj/.venv/Scripts/python.exe' -c \"import sys; print(sys.version)\"",
    // here-string written into a workspace file, then more commands
    `${HERE_CODE}; Remove-Item 'D:/work/proj/src/win_tests.rs'; cargo test --offline -p core -- --nocapture 2>&1 | Select-Object -Last 3`,
    // read-only system tools and side-effect-free .NET statics
    'fsutil volume diskfree D:',
    "[System.IO.DriveInfo]::GetDrives() | Where-Object {$_.Name -in @('C:\\','D:\\')} | Select-Object Name",
    "$dir='D:/work/proj'; $name=('run_'+'all.ps1'); $path=Join-Path $dir $name; [System.Management.Automation.Language.Parser]::ParseFile($path,[ref]$t,[ref]$e) | Out-Null",
    'git -C D:/work/proj rev-parse --is-inside-work-tree 2>&1',
  ]) {
    assert.equal(cmd(c).kind, 'allow', c)
  }
  assert.equal(cmd('FOO=1 cargo build', linux).kind, 'allow')
  assert.equal(cmd('x=$(ls); echo $x', linux).kind, 'allow')
  assert.equal(cmd('(cd sub && make)', linux).kind, 'allow')
})

test('hidden dangers inside newly accepted patterns are still caught', () => {
  const denied: Array<[string, string]> = [
    ["$p='x'; git push origin main", 'git-remote'],
    ['cmd /c "git push"', 'git-remote'],
    ['cmd /c "dir & del C:\\Windows\\x.txt"', 'write-outside-root'],
    ['cmd /c "cargo test > C:\\x.log 2>&1"', 'write-outside-root'],
    ["Select-Object @{n='x';e={Remove-Item C:/outside -Recurse}}", 'write-outside-root'],
    ["$c='Remove-Item'; & $c C:/outside -Recurse", 'write-outside-root'],
    ["$a='Remove'; $b='-Item'; & \"$a$b\" C:/outside", 'write-outside-root'],
    ['Write-Output "$(Remove-Item C:/outside -Recurse)"', 'write-outside-root'],
    ['"{0}" -f (Remove-Item C:/outside)', 'write-outside-root'],
    ['if(-not (Test-Path x)){ Remove-Item C:/outside -Recurse }', 'write-outside-root'],
    ['$env:X=$(Remove-Item C:/outside)', 'write-outside-root'],
    ['pwsh -Command "Remove-Item C:/outside -Recurse"', 'write-outside-root'],
    ['powershell -NoProfile -c "git push"', 'git-remote'],
    ['git -C C:/outside push', 'git-remote'],
    ['git -C D:/work/proj -c core.x=1 remote set-url origin https://x.y/z', 'git-remote'],
    ["$p='C:/Windows/x.txt'; Set-Content $p -Value 1", 'write-outside-root'],
    [`${HERE_CODE}; Remove-Item C:/outside`, 'write-outside-root'],
  ]
  for (const [c, rule] of denied) {
    const v = cmd(c)
    assert.equal(v.kind, 'deny', c)
    assert.equal(v.rule, rule, c)
  }
  const escalated: Array<[string, string]> = [
    ['cmd /c "dir & someunknowntool"', 'unknown-command'],
    ["$m='C:/tools/evil.exe'; & $m --x", 'unknown-command'],
    ["& ('Remove'+'-Item') C:/outside", 'dynamic-command'],
    ['& $unknown --flag', 'dynamic-command'],
    ["$env:PATH='D:/work/proj/bin;'+$env:PATH; cargo build", 'env-loader'],
    ['powershell -EncodedCommand ZQBjAGgAbwA=', 'encoded-command'],
    ['pwsh -NoProfile -ExecutionPolicy Bypass -File C:/elsewhere/x.ps1', 'script-outside-root'],
    ['pwsh -File $s', 'dynamic-command'],
    ['fsutil file createnew x 1', 'unknown-command'],
    ['powercfg /setactive SCHEME_MIN', 'unknown-command'],
    ["[System.IO.Pipes.NamedPipeServerStream]::new('p')", 'dotnet-call'],
    ["[System.IO.File]::WriteAllText('D:/work/proj/x','y')", 'dotnet-call'],
    ["[Environment]::SetEnvironmentVariable('X','y','Machine')", 'dotnet-call'],
    ["$py='D:/work/py/python.exe'; @'\nimport os\n'@ | & $py -", 'inline-stdin-code'],
    ['Remove-Item "$unknown/x"', 'dynamic-target'],
    ['Remove-Item (Join-Path a b) -Recurse', 'dynamic-target'],
    ['git -C C:/other commit -m x', 'git-outside-root'],
  ]
  for (const [c, rule] of escalated) {
    const v = cmd(c)
    assert.equal(v.kind, 'escalate', c)
    assert.equal(v.rule, rule, c)
  }
  // A here-string body is data: `>` inside it is not a redirect.
  assert.equal(cmd("Add-Content -Path a.rs -Value @'\nif a > b {}\n'@").kind, 'allow')
  // POSIX shell variants.
  assert.equal(cmd('x=$(rm -rf /home/u)', linux).kind, 'deny')
  assert.equal(cmd('echo "$(rm -rf /home/u)"', linux).kind, 'deny')
  assert.equal(cmd('echo `rm -rf /home/u`', linux).kind, 'deny')
  assert.equal(cmd('bash -c "rm -rf /home/u"', linux).kind, 'deny')
  assert.equal(cmd('$CMD -rf /', linux).rule, 'dynamic-command')
  assert.equal(cmd('PATH=/tmp:$PATH cargo build', linux).rule, 'env-loader')
})

test('nested bodies are split into their own segments', () => {
  assert.deepEqual(splitSegments('Remove-Item (Join-Path a b) -Recurse'), ['Join-Path a b', 'Remove-Item $__djy_sub -Recurse'])
  assert.deepEqual(splitSegments('echo "x$(whoami)y"'), ['whoami', 'echo "x$__djy_suby"'])
  assert.deepEqual(splitSegments("@'\na; b (c)\n'@ | x"), ["@'\na; b (c)\n'@", 'x'])
})

test('the plugin data dir is off limits: no reading the MCP token, no writing personal rules', () => {
  assert.equal(classify('read', { file_path: 'C:/Users/u/.dsh/dujiangyan/token' }, win).rule, 'credential-read')
  assert.equal(classify('pwsh', { command: 'Get-Content C:/Users/u/.dsh/dujiangyan/token' }, win).rule, 'credential-read')
  assert.equal(classify('write', { file_path: 'C:/Users/u/.dsh/dujiangyan/local-rules.json', content: '{}' }, win).rule, 'config-write')
  assert.equal(classify('pwsh', { command: "$p='C:/Users/u/.dsh/dujiangyan/local-rules.json'; Set-Content $p -Value 1" }, win).kind, 'deny')
  // a relocated data dir is protected through protectedDirs
  const relocated: GateContext = { ...win, protectedDirs: ['E:/djy-state'] }
  assert.equal(classify('write', { file_path: 'E:/djy-state/local-rules.json', content: '{}' }, relocated).rule, 'config-write')
  assert.equal(classify('read', { file_path: 'E:/djy-state/token' }, relocated).rule, 'credential-read')
  assert.equal(classify('read', { file_path: 'E:/djy-state/CONNECT.md' }, relocated).kind, 'allow', 'other files there stay readable')
})

test('console encoding assignments are harmless; a hidden call on the right-hand side is not', () => {
  assert.equal(cmd('[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Content D:/work/proj/DESIGN.md -Encoding UTF8').kind, 'allow')
  assert.equal(cmd('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8').kind, 'allow')
  assert.equal(cmd('[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)').kind, 'allow')
  // Hidden-danger variants: the value is not a plain encoding.
  assert.equal(cmd("[Console]::OutputEncoding=[IO.File]::Delete('C:/outside/x')").kind, 'escalate')
  assert.equal(cmd('[Console]::Clear()').kind, 'escalate')
  assert.equal(cmd('[Console]::OutputEncoding=$(Remove-Item C:/outside -Recurse)').kind, 'deny')
})

test('a wildcard only in the last path segment is judged by its directory', () => {
  assert.equal(cmd("Remove-Item 'D:/work/proj/results/raw/*.verify.jsonl' -Force").kind, 'allow')
  assert.equal(cmd('Remove-Item D:\\work\\proj\\target\\tmp_*').kind, 'allow')
  assert.equal(cmd('Remove-Item results/smoke/*.jsonl').kind, 'allow')
  // Hidden-danger variants.
  assert.equal(cmd('Remove-Item C:/outside/*').rule, 'write-outside-root')
  assert.equal(cmd('Remove-Item ../*').rule, 'write-outside-root')
  assert.equal(cmd('Remove-Item D:/work/proj/* -Recurse').kind, 'escalate') // a whole root
  assert.equal(cmd('Remove-Item D:/work/*/x').kind, 'escalate') // wildcard above the last segment
  assert.equal(cmd('Remove-Item "$env:TEMP/*"').kind, 'escalate')
  assert.equal(cmd('Remove-Item C:/Users/u/.ssh/*').kind, 'deny')
})

test('read-only git plumbing is allowed; remotes still are not', () => {
  for (const sub of ['rev-list --count HEAD', 'ls-tree HEAD', 'show-ref', 'for-each-ref', 'name-rev HEAD', 'merge-base a b', 'count-objects -v', 'grep foo']) {
    assert.equal(cmd(`git ${sub}`).kind, 'allow', sub)
  }
  assert.equal(cmd('git -C D:/work/proj rev-list --count HEAD').kind, 'allow')
  assert.equal(cmd('git -C D:/work/proj push').kind, 'deny')
  assert.equal(cmd('git fetch').kind, 'escalate')
})

test('an attached redirect (>f) does not hide the next write target (review H1)', () => {
  assert.notEqual(cmd('rm >f D:/outside/x.txt').kind, 'allow')
  assert.notEqual(cmd('rm 2>f D:/outside/x.txt').kind, 'allow')
  assert.notEqual(cmd('rm > f D:/outside/x.txt').kind, 'allow')
  assert.notEqual(cmd('rm 2>&1 D:/outside/x.txt').kind, 'allow')
  assert.notEqual(cmd('rm *>&1 D:/outside/x.txt').kind, 'allow')
  assert.notEqual(cmd('rm 2>> f D:/outside/x.txt').kind, 'allow')
  assert.equal(cmd('rm >f data/x.txt').kind, 'allow')
  assert.equal(cmd('rm data/x.txt 2>&1').kind, 'allow')
})

test('PowerShell aliases are normalized: read aliases pass, write aliases keep their target checks', () => {
  assert.equal(cmd('Get-ChildItem data -File | ? { $_.Length -gt 0 } | % { $_.Name }').kind, 'allow')
  assert.equal(cmd('gci data | select Name,Length | ft -AutoSize').kind, 'allow')
  assert.equal(cmd('gc data/a.txt | sls pattern').kind, 'allow')
  assert.notEqual(cmd('ri -Recurse C:/Users/u/Documents').kind, 'allow')
  assert.notEqual(cmd('ni C:/Windows/x.txt').kind, 'allow')
  assert.notEqual(cmd('gci data | % { Remove-Item C:/Windows/x.txt }').kind, 'allow', 'commands inside a ForEach block are still judged')
})

test('the host tool that reports bundled runtime paths is read-only', () => {
  assert.equal(kind('load_workspace_dependencies', {}), 'allow')
})
