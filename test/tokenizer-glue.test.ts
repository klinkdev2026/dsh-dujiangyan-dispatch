import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyCommand, type GateContext } from '../src/rules.ts'

const win: GateContext = {
  cwd: 'D:\\work\\proj',
  roots: ['D:\\work\\proj'],
  home: 'C:\\Users\\u',
  platform: 'win32',
  holdsBench: false,
  canonical: p => p,
}
const cmd = (command: string) => classifyCommand(command, win)

// Real worker commands that were escalated as "unknown-command" only because a keyword was glued
// to its parenthesis or brace, or a string concatenation held a subexpression.
test('control keywords glued to ( or { are recognized; their bodies are still judged', () => {
  const ok = [
    "foreach($d in 'a','b'){ Get-ChildItem $d -File | % { $_.Name } }",
    "$o = foreach($d in 'a','b'){ \"=== $d\"; Get-ChildItem $d -Directory | Select-Object -Expand Name }",
    'foreach($v in 0,1){ if($v){ "one" }else{ "zero" } }',
    '$n = 3; if($n -gt 2){ Get-ChildItem data }elseif($n -eq 1){ "one" }else{ "none" }',
    '$o = Get-Content data/log.txt; "clippy: " + (($o | Select-String "^(warning|error)").Count) + " warn/err"',
    'while($true){ break }',
    'switch($x){ 1 { "a" } default { "b" } }',
    'Get-ChildItem data -File | ?{ $_.Length -gt 0 } | %{ $_.Name }',
    'Get-ChildItem data | Where-Object{ $_.Name -match "x" } | ForEach-Object{ $_.Length }',
  ]
  for (const c of ok) assert.equal(cmd(c).kind, 'allow', c)
  const bad = [
    "foreach($d in 'a'){ Remove-Item C:/Windows/x.txt }",
    'if($true){ Remove-Item -Recurse C:/Users/u/Documents }else{ "x" }',
    "foreach($d in 'a'){ curl.exe https://example.com }",
    'Get-ChildItem data | %{ Remove-Item C:/Windows/x.txt }',
  ]
  for (const c of bad) assert.notEqual(cmd(c).kind, 'allow', c)
})
