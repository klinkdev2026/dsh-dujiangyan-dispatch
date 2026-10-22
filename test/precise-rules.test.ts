import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, classifyCommand, type GateContext } from '../src/rules.ts'

// Phase 2 "precise allowances": the call shapes that made up most of the 2026-10-20 approvals
// (130 in 6.5 h, 12 timeouts overnight), each with the variants that must keep escalating or be denied.

const ws = 'D:\\work\\proj'
const win: GateContext = {
  cwd: ws,
  roots: [ws],
  home: 'C:\\Users\\u',
  platform: 'win32',
  holdsBench: false,
  canonical: p => p,
  config: {
    allowEnv: [
      { name: 'PATH', prepend: ['C:/Python313'] },
      { name: 'PATH', append: ['C:/tools/bin'] },
    ],
    allowPrograms: [{ path: 'C:/Apps/KLayout/klayout_app.exe', args: '^-b\\b', scriptFlag: '-r' }],
  },
  readScript: p => (p.replace(/\\/g, '/').endsWith('tools/common.ps1') ? 'function Invoke-Limited { param($exe) }\nfilter Get-Tag { $_ }\n' : undefined),
}
const cmd = (command: string, g = win) => classifyCommand(command, g)
const expectAll = (k: 'allow' | 'deny' | 'escalate', list: readonly string[], g = win) => {
  for (const c of list) assert.equal(cmd(c, g).kind, k, `${k}: ${c} → ${JSON.stringify(cmd(c, g))}`)
}

test('R1 comments are not commands, and a comment never hides code that runs', () => {
  expectAll('allow', [
    "$exe='D:/work/proj/target/release/x.exe' # build output\nGet-ChildItem data",
    '# list the results\nGet-ChildItem results',
    '<# block\ncomment #> Get-ChildItem data',
    'Get-ChildItem data # trailing note with Remove-Item C:/outside',
  ])
  // `#` inside a word or a string is not a comment: the rest of the line still runs and is judged.
  expectAll('deny', [
    'Write-Output "#"; Remove-Item C:/outside -Recurse',
    "Write-Output 'a#b'; Remove-Item C:/outside",
    'Get-ChildItem data#x; Remove-Item C:/outside',
    '# note\nRemove-Item C:/outside',
  ])
  assert.equal(classifyCommand('ls # x\nrm -rf /etc', { ...win, cwd: '/ws', roots: ['/ws'], platform: 'linux' }, 'bash').kind, 'deny')
})

test('R2 Start-Process: a waited program runs like a direct call', () => {
  expectAll('allow', [
    "$p = Start-Process -FilePath D:/work/proj/target/release/s15.exe -ArgumentList 'run','--db','data/x.k15' -NoNewWindow -PassThru; if(-not $p.WaitForExit(60000)){ $p.Kill(); 'TIMEOUT' }",
    "$exe='D:/work/proj/target/release/s01.exe'; $p=Start-Process -FilePath $exe -ArgumentList @('--synth','grid','--threads','4') -RedirectStandardOutput results/raw/o.json -RedirectStandardError results/raw/o.err -PassThru -NoNewWindow; $null=$p.WaitForExit(120000)",
    "Start-Process D:/work/proj/target/release/x.exe -Wait -NoNewWindow",
    "$p = Start-Process -FilePath python -ArgumentList 'tools/gen.py','out.gds' -PassThru; $p.WaitForExit(600000)",
    "$kl='C:/Apps/KLayout/klayout_app.exe'; $p = Start-Process -FilePath $kl -ArgumentList '-b','-r','tools/kl_ref.rb','-rd','dir=results/raw' -PassThru -NoNewWindow; if(-not $p.WaitForExit(600000)){ $p.Kill() }",
    "$p = Start-Process -FilePath D:/work/proj/target/release/x.exe -WorkingDirectory D:/work/proj/s15 -RedirectStandardOutput \"$env:TEMP/x.out\" -PassThru; $p.WaitForExit(1000)",
    // Arguments computed at run time are fine for a workspace binary (a direct call does not check them either).
    "$a = Get-Content args.txt; $p = Start-Process -FilePath D:/work/proj/target/release/x.exe -ArgumentList $a -PassThru; $p.WaitForExit(1000)",
  ])
})

test('R2 Start-Process: what still needs an approver or is refused', () => {
  // Not waited: the program outlives the call (orphan processes polluted measurements, findings 40).
  assert.equal(cmd('Start-Process -FilePath D:/work/proj/target/release/x.exe -NoNewWindow').rule, 'detached-process')
  assert.equal(cmd('Start-Process D:/work/proj/target/release/x.exe -Verb RunAs -Wait').kind, 'deny')
  expectAll('escalate', [
    'Start-Process -FilePath C:/Tools/other.exe -Wait',
    "$p = Start-Process -FilePath C:/Apps/KLayout/klayout_app.exe -ArgumentList 'tools/x.lym' -PassThru; $p.WaitForExit(1)", // GUI mode (no -b)
    "$p = Start-Process -FilePath C:/Apps/KLayout/klayout_app.exe -ArgumentList '-b','-r','C:/elsewhere/x.rb' -PassThru; $p.WaitForExit(1)",
    "$p = Start-Process -FilePath C:/Apps/KLayout/klayout_app.exe -ArgumentList $a -PassThru; $p.WaitForExit(1)", // args unknown
    "$p = Start-Process -FilePath (Get-Item x).FullName -PassThru; $p.WaitForExit(1)",
    'Start-Process D:/work/proj/target/release/x.exe -Credential $c -Wait',
    'Start-Process D:/work/proj/target/release/x.exe -WorkingDirectory C:/elsewhere -Wait',
    'Start-Process D:/work/proj/target/release/x.exe -Bogus 1 -Wait',
    "$p = Start-Process -FilePath python -ArgumentList '-' -PassThru; $p.WaitForExit(1)", // stdin program
  ])
  expectAll('deny', [
    'Start-Process D:/work/proj/target/release/x.exe -RedirectStandardOutput C:/elsewhere/out.txt -Wait',
    "$p = Start-Process -FilePath cmd.exe -ArgumentList '/c','del C:\\Windows\\x' -PassThru; $p.WaitForExit(1)",
  ])
})

test('R3 $env:TEMP is the worker\'s scratch directory', () => {
  expectAll('allow', [
    'cargo test --offline --release > $env:TEMP\\s15_test.txt 2> $env:TEMP\\s15_err.txt',
    "'run --db x' | Out-File -Encoding ascii $env:TEMP/a1.txt",
    "$o = Join-Path $env:TEMP 's14_smoke.jsonl'; Remove-Item $o -ErrorAction SilentlyContinue",
    '$f = "$env:TEMP/mcfull_args.txt"; Set-Content -Path $f -Value "run --db data/x.k15"',
    'Remove-Item $env:TEMP/s15/*.tmp',
    'Copy-Item $env:TMP/x.json results/raw/x.json',
  ])
  expectAll('escalate', [
    'Set-Content $env:TEMP/../evil.txt x',
    'Remove-Item $env:TEMP -Recurse',
    'Remove-Item $env:TEMP/*',
    'Set-Content "${env:TEMP}x" y',
    'Set-Content $env:TEMPX/a y',
    'Set-Content $env:USERPROFILE/a y',
    '& "$env:TEMP/tool.exe"',
  ])
})

test('R4 Join-Path, $PWD, (Resolve-Path x).Path and foreach values resolve; each value is checked', () => {
  expectAll('allow', [
    "$o = Join-Path 'results/raw' 'x.json'; Set-Content $o '{}'",
    '$r="$PWD/results/raw/case.lyrdb"; Set-Content $r x',
    "$g=(Resolve-Path results/raw/x.gds).Path; Copy-Item $g results/raw/y.gds",
    "foreach($d in @('src','tools','results/raw')){ New-Item -ItemType Directory -Force -Path \"D:/work/proj/s18/$d\" | Out-Null }",
    "foreach($th in 1,20){ $out=\"$env:TEMP/s01_t$th.json\"; Set-Content $out x }",
    "$bins = 'a','b'; foreach ($b in $bins) { & \"D:/work/proj/target/release/$b.exe\" --help }",
  ])
  // One bad value is enough.
  expectAll('deny', [
    "foreach($d in 'ok','../../outside'){ New-Item -ItemType Directory \"D:/work/proj/$d\" }",
    "foreach($n in 'a','.env'){ Set-Content \"data/$n\" x }",
    "$o = Join-Path 'C:/elsewhere' 'x.txt'; Set-Content $o y",
  ])
  expectAll('escalate', [
    "$o = Join-Path $root 'x.txt'; Set-Content $o y", // $root unknown
    "foreach($d in (Get-ChildItem)){ Remove-Item \"data/$d\" }",
    "foreach($d in @(Get-Item x)){ Remove-Item $d }", // @( … ) running a command is not a literal list
  ])
  // `$p += …` makes a once-known value unknown (it used to keep only the appended part).
  assert.equal(cmd("$p = 'C:/'; $p += 'Windows/x.txt'; Set-Content $p y").kind, 'escalate')
})

test('R5 functions defined in the command or dot-sourced from a workspace script', () => {
  expectAll('allow', [
    'function cnt($t){ Get-Content results/raw/$t/summary.json -Raw | ConvertFrom-Json }; (cnt r4_a) | % { $_ }',
    ". ./tools/common.ps1; $r = Invoke-Limited $S15Exe \"run --db data/x.k15\" 2048 300",
    '. ./tools/common.ps1; Get-ChildItem | Get-Tag',
  ])
  // The function body is still judged, and a path that merely ends in a function's name is not that function.
  expectAll('deny', [
    'function cleanup { Remove-Item C:/outside -Recurse }; cleanup',
    "function x { 'ok' }; & 'C:/elsewhere/x.exe'; Remove-Item C:/outside",
  ])
  expectAll('escalate', [
    "function x { 'ok' }; & 'C:/elsewhere/x.exe'",
    '. C:/elsewhere/common.ps1; Invoke-Limited x', // a script outside the roots is not read
    '. ./tools/other.ps1; Invoke-Limited x', // the script does not define it
  ])
})

test('R6 allowEnv: only the listed directories may be added to PATH', () => {
  expectAll('allow', [
    '$env:PATH = "C:/Python313;$env:PATH"; & D:/venv/Scripts/python.exe tools/x.py',
    '$env:PATH="C:\\Python313;$env:PATH"; cargo build --offline',
    "$py='C:/Python313'; $env:PATH=\"$py;$env:PATH\"; python tools/x.py",
    '$env:PATH = "$env:PATH;C:/tools/bin"',
  ])
  expectAll('escalate', [
    '$env:PATH = "C:/Evil;$env:PATH"',
    '$env:PATH = "C:/Python313;C:/Evil;$env:PATH"',
    '$env:PATH = "C:/Python313"', // replaces PATH instead of extending it
    '$env:PATH = "$(Get-Evil);$env:PATH"',
    '$env:PATH += ";C:/Python313"',
    '$env:PATH = "$env:TEMP;$env:PATH"',
    '$env:PSModulePath = "C:/Python313;$env:PSModulePath"', // listed for PATH only
  ])
  assert.equal(cmd('$env:PATH = "C:/Python313;$env:PATH"', { ...win, config: {} }).kind, 'escalate')
  const linux: GateContext = { ...win, cwd: '/ws', roots: ['/ws'], home: '/home/u', platform: 'linux', config: { allowEnv: [{ name: 'PATH', prepend: ['/opt/py/bin'] }] } }
  assert.equal(classifyCommand('PATH=/opt/py/bin:$PATH python x.py', linux, 'bash').kind, 'allow')
  assert.equal(classifyCommand('PATH=/tmp/evil:$PATH python x.py', linux, 'bash').kind, 'escalate')
})

test('R7 allowPrograms: an exact program path, with its argument and script constraints', () => {
  expectAll('allow', [
    "& 'C:/Apps/KLayout/klayout_app.exe' -b -v | Out-String",
    "& 'C:\\Apps\\KLayout\\klayout_app.exe' -b -r tools/oracle_app.rb -rd input=cases/smoke.txt",
    "$o = @(); $o += (& 'C:/Apps/KLayout/klayout_app.exe' -b -v | Out-String).Trim()",
  ])
  expectAll('escalate', [
    "& 'C:/Apps/KLayout/klayout_app.exe' tools/x.gds", // GUI
    "& 'C:/Apps/KLayout/klayout_app.exe' -b -r C:/elsewhere/x.rb",
    "& 'C:/Apps/KLayout/klayout_app.exe' -b -r $script",
    "& 'C:/Apps/KLayout2/klayout_app.exe' -b -v",
  ])
  expectAll('deny', ["& 'C:/Apps/KLayout/klayout_app.exe' -b -v > C:/elsewhere/v.txt"])
})

test('R8 working_directory and job tools', () => {
  assert.equal(classify('working_directory', {}, win).kind, 'allow')
  assert.equal(classify('working_directory', { path: 'D:/work/proj/s15' }, win).kind, 'allow')
  assert.equal(classify('working_directory', { path: 'C:/elsewhere' }, win).kind, 'escalate')
  assert.equal(classify('working_directory', { path: 1 }, win).kind, 'escalate')
  assert.equal(classify('job_output', { job_id: 'j1', wait: true }, win).kind, 'allow')
  assert.equal(classify('job_kill', { job_id: 'j1' }, win).kind, 'allow')
})

test('R9 a double-quoted nested command sees the outer variables; hashtable entries are values', () => {
  expectAll('allow', [
    "$root='D:/work/proj/s18'; $py='C:/Python313/python.exe'; $pp='D:/venv/Lib/site-packages'; & powershell -NoProfile -ExecutionPolicy Bypass -Command \"& '$root/tools/run_limited.ps1' -Exe '$py' -ArgLine '$root/tools/memtest.py' -TimeoutSec 60 -Env @{ PYTHONPATH = '$pp' }\" | Out-Null",
    "Get-PSDrive D | Select-Object @{n='FreeGB';e={[math]::Round($_.Free/1GB,2)}}",
  ])
  expectAll('deny', [
    "$t='C:/elsewhere'; powershell -Command \"Remove-Item '$t' -Recurse\"",
    "$h = @{ a = Remove-Item C:/outside -Recurse }",
  ])
  // Single quotes: the child gets the text unexpanded, so the outer variable does not apply.
  assert.equal(cmd("$t='D:/work/proj/x'; powershell -Command '& \"$t/tool.exe\"'").kind, 'escalate')
})

test('small additions: exit, Add-Type -AssemblyName, ComputerInfo memory, Set-Content data is not a path', () => {
  expectAll('allow', [
    "$p = Start-Process -FilePath cmd.exe -ArgumentList '/c','exit 3' -NoNewWindow -PassThru; $null=$p.WaitForExit(10000)",
    'Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Devices.ComputerInfo]::new().TotalPhysicalMemory',
    'Set-Content -Encoding utf8 "D:/work/proj/src/lib.rs" "//! stub"',
    'Add-Content results/log.txt "/etc/passwd mentioned in a log line"',
  ])
  expectAll('escalate', [
    'Add-Type -TypeDefinition "public class X {}"',
    'Add-Type -Path C:/elsewhere/x.dll',
    'Add-Type -AssemblyName $name',
  ])
  expectAll('deny', ['Set-Content C:/elsewhere/x.txt "data"', 'Set-Content -Value x -Path C:/elsewhere/y'])
})

test('redirect operators never swallow the next write target (Kimi H1 and its 2>&1 variant)', () => {
  expectAll('deny', [
    'rm 2>&1 D:/outside/x.txt',
    'rm >f D:/outside/x.txt',
    'Remove-Item 2>&1 D:/outside/x',
    'rm *>&1 D:/outside/x',
    'rm 1>&2 D:/outside/x',
    'rm 2>$null D:/outside/x',
    'rm 2>&1 >D:/outside/y',
  ])
})

test('the gate\'s own marker characters cannot be smuggled into a command', () => {
  for (const c of ['\u0000scratch/x', '\u0001', '\u0002', '\u0003 rm = \'x\'']) assert.equal(cmd(`Set-Content ${c} y`).kind, 'escalate')
})

// Kimi's phase-2 review (2026-10-21): allowances that could be talked past.
test('Kimi P2-H1: a function named like a built-in command is not trusted as a local function', () => {
  const g: GateContext = { ...win, readScript: p => (p.replace(/\\/g, '/').endsWith('tools/common.ps1') ? 'function Remove-Item { param($p) }\nfunction Invoke-Limited { }\n' : undefined) }
  expectAll('escalate', [
    'function rm { param($p) }; rm C:/outside -Recurse',
    'function Remove-Item { param($p) }; Remove-Item C:/outside -Recurse',
    '. ./tools/common.ps1; Remove-Item C:/outside/x',
  ], g)
  expectAll('allow', ['. ./tools/common.ps1; Invoke-Limited x'], g)
})

test('Kimi P2-H2: ~ is the home directory, not a folder named ~ in the workspace', () => {
  expectAll('deny', [
    'Set-Content ~/evil.txt x',
    "Add-Content (Resolve-Path '~/.gitconfig').Path x",
    "Remove-Item (Resolve-Path '~/x.txt').Path",
    'Get-Content ~/.ssh/id_rsa',
  ])
  expectAll('escalate', ['Set-Content ~other/x y'])
})

test('Kimi P2-H3: after cd, relative paths and $PWD are judged from every directory the shell may be in', () => {
  expectAll('deny', [
    'Set-Location C:/Users/Public; Set-Content "$PWD/evil.txt" x',
    'Set-Location C:/Users/Public; $f = Join-Path $PWD evil.txt; Set-Content $f x',
    'Set-Location ..; Set-Content "$PWD/evil.txt" x',
    'Push-Location C:/; Set-Content "$PWD/x" x',
    'cd C:/Users/Public; Set-Content evil.txt x',
    'cd sub; Remove-Item ../../x',
    'if ($a) { cd sub/deeper }; Set-Content ../../x y',
  ])
  expectAll('escalate', ['cd $dir; Set-Content x y', 'Set-Location -StackName s; Set-Content x y'])
  expectAll('allow', [
    'cd D:/work/proj/s15; Set-Content out.txt x',
    'Push-Location s15; cargo build --release; Pop-Location',
    'cd s15; Set-Content "$PWD/out.txt" x',
  ])
  const linux: GateContext = { ...win, cwd: '/ws', roots: ['/ws'], home: '/home/u', platform: 'linux' }
  assert.equal(classifyCommand('cd /tmp && rm -rf x', linux, 'bash').kind, 'deny')
  assert.equal(classifyCommand('cd sub && rm -rf x', linux, 'bash').kind, 'allow')
})

test('Kimi P2-H4: a wait in a string, a comment or on another process does not count', () => {
  expectAll('escalate', [
    'Start-Process D:/work/proj/x.exe -NoNewWindow; Write-Output ".WaitForExit("',
    'Start-Process D:/work/proj/x.exe -NoNewWindow # $p.WaitForExit(1)',
    '$p=Start-Process D:/work/proj/a.exe -PassThru; $p.WaitForExit(1); Start-Process D:/work/proj/b.exe -NoNewWindow',
    '$p=Start-Process D:/work/proj/a.exe; $p.WaitForExit(1)', // no -PassThru: $p is null
    "$p=Start-Process D:/work/proj/a.exe -PassThru; Write-Output '$p.WaitForExit(1)'",
  ])
  expectAll('allow', [
    '$p=Start-Process D:/work/proj/a.exe -PassThru; $p | Wait-Process -Timeout 60',
    '$p=Start-Process D:/work/proj/a.exe -PassThru; Wait-Process -Id $p.Id -Timeout 60',
  ])
})

test('findings 53: a HasExited poll loop that kills on its deadline counts as waiting', () => {
  expectAll('allow', [
    '$p=Start-Process D:/work/proj/a.exe -PassThru -NoNewWindow; $t0=Get-Date; while(-not $p.HasExited){ Start-Sleep -Milliseconds 200; if(((Get-Date)-$t0).TotalSeconds -gt 60){ $p.Kill(); break } }',
    '$p=Start-Process D:/work/proj/a.exe -PassThru; $n=0; while (!$p.HasExited) { Start-Sleep 1; $n++; if ($n -gt 60) { $p.Kill() } }',
  ])
  expectAll('escalate', [
    // No kill: the loop may end early and leave the program running.
    '$p=Start-Process D:/work/proj/a.exe -PassThru; $n=0; while(-not $p.HasExited -and $n -lt 5){ Start-Sleep 1; $n++ }',
    // The loop and the kill are only text.
    "$p=Start-Process D:/work/proj/a.exe -PassThru; Write-Output 'while(-not $p.HasExited){ $p.Kill() }'",
    // Another process is polled.
    '$p=Start-Process D:/work/proj/a.exe -PassThru; $q=Start-Process D:/work/proj/b.exe -PassThru; while(-not $q.HasExited){ $q.Kill() }',
  ])
})

test('Kimi P2-H5: an all-streams redirect (*>) target is judged', () => {
  expectAll('deny', ['python tools/x.py *> C:/outside/log.txt', 'python tools/x.py *>C:/outside/log.txt', 'python tools/x.py *>> C:/outside/log.txt'])
  expectAll('allow', ['python tools/x.py *> logs/x.txt', 'python tools/x.py *>&1'])
})

test('findings 55: tool names of other agent hosts are refused at once with the name to use', () => {
  for (const [tool, use] of [['Bash', 'pwsh'], ['Read', 'read'], ['ToolSearch', 'no deferred tools'], ['apply_patch', 'edit']] as const) {
    const v = classify(tool, { command: 'Get-ChildItem' }, win)
    assert.equal(v.kind, 'deny', tool)
    assert.equal(v.rule, 'foreign-tool')
    assert.match(v.reason ?? '', new RegExp(use))
  }
  // A tool the gate does not know but the host may have still goes to an approver.
  assert.equal(classify('some_new_tool', {}, win).rule, 'unknown-tool')
  assert.equal(classify('bash', { command: 'ls' }, win).kind !== 'deny' || classify('bash', { command: 'ls' }, win).rule !== 'foreign-tool', true)
})

test('smoke 2026-10-21: cd into an existing directory, then a relative write, stays in the write scope', () => {
  const dirs = new Set(['D:\\work\\proj\\out', 'D:\\work\\proj\\out\\smoke'])
  const g: GateContext = { ...win, writeScope: ['D:\\work\\proj\\out'], isDirectory: p => dirs.has(p) }
  expectAll('allow', [
    'cd D:/work/proj/out/smoke; Set-Content b.txt "in subdir"; Get-ChildItem | Select-Object Name',
    'Set-Location out; Set-Content b.txt x',
  ], g)
  // The shell may still be in the old directory: a missing target (cd fails), after &&/||, or inside a block.
  expectAll('deny', [
    'cd D:/work/proj/out/missing; Set-Content b.txt x',
    'Test-Path x && cd D:/work/proj/out/smoke; Set-Content b.txt x',
    'if ($a) { cd D:/work/proj/out/smoke }; Set-Content b.txt x',
  ], g)
  // A sure cd to somewhere outside makes relative writes land outside.
  assert.equal(cmd('cd C:/Users/Public; Set-Content b.txt x', { ...g, isDirectory: () => true }).kind, 'deny')
})

test('findings 57: sandbox_permissions equal to the effective mode is judged as if absent; anything else escalates', () => {
  const ww: GateContext = { ...win, sandboxMode: 'workspace-write' }
  const call = (sp: unknown, command = 'Get-ChildItem data', g = ww) => classify('pwsh', { command, sandbox_permissions: sp, justification: 'needed' }, g)
  assert.equal(call('workspace-write').kind, 'allow')
  assert.equal(call(' workspace-write ').kind, 'allow')
  // The command itself is still judged.
  assert.equal(call('workspace-write', 'Remove-Item C:/outside -Recurse').kind, 'deny')
  for (const sp of ['danger-full-access', 'Workspace-Write', 'read-only', 'bogus', '', 1, null]) {
    assert.equal(call(sp).rule, 'sandbox-escalation', String(sp))
  }
  // Mode unknown (host accessor absent or failing): fail closed.
  assert.equal(call('workspace-write', 'Get-ChildItem data', win).rule, 'sandbox-escalation')
  assert.equal(call('workspace-write', 'Get-ChildItem data', { ...win, sandboxMode: '' }).rule, 'sandbox-escalation')
})

test('overnight: New-Object of a pure data type runs no code; COM and other types still escalate', () => {
  expectAll('allow', [
    '"D: free: $([math]::Round((New-Object IO.DriveInfo(\'D\')).AvailableFreeSpace/1GB,1)) GB"',
    '$l = New-Object System.Collections.Generic.List[long]',
    '$sb = New-Object -TypeName System.Text.StringBuilder',
  ])
  expectAll('escalate', [
    'New-Object -ComObject WScript.Shell',
    '$c = New-Object Net.WebClient',
    '$p = New-Object System.Diagnostics.Process',
    'New-Object IO.DriveInfo -ComObject x',
  ])
})

test('overnight S17: cmd /c "set NAME=value&& program" sets a variable for the program', () => {
  expectAll('allow', [
    'cmd /c "set KBX_STREAM=1&& D:/work/proj/target/release/kbx_run.exe corpus/out/one_case.txt NUL --intra 1 2>NUL"',
    'cmd /c "set KBX_SCAN_DEBUG=1&& set KBX_STREAM=&& D:/work/proj/target/release/kbx_run.exe a.txt NUL 2>corpus/out/mat.trace.txt"',
    'cmd /c "set "KBX_MODE=a b"&& D:/work/proj/target/release/kbx_run.exe a.txt"',
    'cmd /c set',
    // As S17 wrote it, with backslashes.
    'cmd /c "set KBX_STREAM=1&& D:\\work\\proj\\target\\release\\kbx_run.exe corpus\\out\\one_case.txt corpus\\out\\mc.stream.txt --intra 1 2>NUL"',
  ])
  expectAll('escalate', [
    'cmd /c "set PATH=C:/evil&& kbx_run.exe"',
    'cmd /c "set /p X=&& D:/work/proj/target/release/kbx_run.exe"',
  ])
  // The program after it is still judged, and so are redirects.
  expectAll('deny', [
    'cmd /c "set KBX_STREAM=1&& del /s /q C:/Windows/x"',
    'cmd /c "set KBX_STREAM=1 > C:/outside/x.txt"',
  ])
})

test('N1 tree-writing git subcommands judge their operands against the roots and the session scope', () => {
  // Two sessions share the repo at the root; this one may only write D:/work/a.
  const g: GateContext = { ...win, cwd: 'D:\\work\\a', roots: ['D:\\work'], writeScope: ['D:\\work\\a'], gitTopLevel: () => 'D:\\work' }
  const deniedOrHeld = (list: string[]) => {
    for (const c of list) assert.notEqual(cmd(c, g).kind, 'allow', `${c} → ${JSON.stringify(cmd(c, g))}`)
  }
  deniedOrHeld([
    'git worktree add ../b/x',
    'git worktree add D:/outside',
    'git init D:/outside/x',
    'git init ../b',
    'git checkout -- ../b/x',
    'git restore --source=HEAD ../b/x',
    'git restore -s HEAD -- ../b/x',
    'git rm ../b/x',
    'git mv x.rs ../b/x.rs',
    'git checkout main',
    'git switch main',
    'git stash',
    'git checkout -- :/',
    'git restore -- "*.rs"',
    'git -C ../b checkout -- x',
    'git worktree remove ../b/wt',
    'git checkout --pathspec-from-file=list.txt',
  ])
  expectAll('allow', [
    'git worktree add wt-feature',
    'git init sub',
    'git checkout -- src/x.rs',
    'git restore --source=HEAD src/x.rs',
    'git rm --cached old.rs',
    'git mv a.rs b.rs',
    'git checkout -b feature',
    'git stash list',
    'git status',
    'git diff ../b',
    'git worktree list',
  ], g)
  // A repo of its own inside the scope may switch branches freely.
  const own: GateContext = { ...g, gitTopLevel: () => 'D:\\work\\a' }
  expectAll('allow', ['git checkout main', 'git switch -c topic', 'git stash', 'git stash pop'], own)
  // Without a scope the roots still bound every operand.
  const solo: GateContext = { ...win, gitTopLevel: () => ws }
  expectAll('allow', ['git checkout main', 'git worktree add ../proj/wt'], solo)
  assert.notEqual(cmd('git worktree add ../elsewhere', solo).kind, 'allow')
  assert.notEqual(cmd('git init D:/outside', solo).kind, 'allow')
})
