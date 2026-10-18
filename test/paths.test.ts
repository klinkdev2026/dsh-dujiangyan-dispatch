import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalPath, isWithin, safeKey } from '../src/paths.ts'

test('isWithin: Windows paths, case-insensitive, separators, drives', () => {
  const root = 'D:\\work\\proj'
  assert.equal(isWithin(root, 'D:\\work\\proj\\data\\x.gds', 'win32'), true)
  assert.equal(isWithin(root, 'd:\\WORK\\Proj\\data', 'win32'), true)
  assert.equal(isWithin(root, 'D:/work/proj/data', 'win32'), true)
  assert.equal(isWithin(root, root, 'win32'), true)
  assert.equal(isWithin(root, 'D:\\work', 'win32'), false)
  assert.equal(isWithin(root, 'D:\\work\\proj2\\x', 'win32'), false)
  assert.equal(isWithin(root, 'C:\\work\\proj', 'win32'), false)
  assert.equal(isWithin(root, 'D:\\work\\proj\\..\\DESIGN.md', 'win32'), false)
  assert.equal(isWithin('\\\\server\\share\\ws', '\\\\server\\share\\ws\\a', 'win32'), true)
})

test('isWithin: POSIX is case-sensitive on Linux, folded on macOS', () => {
  assert.equal(isWithin('/home/u/ws', '/home/u/ws/a/b', 'linux'), true)
  assert.equal(isWithin('/home/u/ws', '/home/u/WS/a', 'linux'), false)
  assert.equal(isWithin('/Users/u/ws', '/users/U/WS/a', 'darwin'), true)
  assert.equal(isWithin('/home/u/ws', '/home/u/ws-other', 'linux'), false)
  assert.equal(isWithin('/home/u/ws', '/home/u/ws/..foo', 'linux'), true)
})

test('canonicalPath keeps a non-existing tail and resolves the existing prefix', () => {
  const real = (p: string) => {
    if (p === '/ws/link') return '/real/target'
    if (p === '/ws' || p === '/') return p
    throw new Error('ENOENT')
  }
  assert.equal(canonicalPath('/ws/link/new/file.txt', 'linux', real), '/real/target/new/file.txt')
  assert.equal(canonicalPath('/ws/plain/file.txt', 'linux', real), '/ws/plain/file.txt')
})

test('safeKey avoids Windows reserved names and unsafe characters', () => {
  assert.equal(safeKey('con'), '_con')
  assert.equal(safeKey('NUL'), '_NUL')
  assert.equal(safeKey('com1'), '_com1')
  assert.equal(safeKey('bench'), 'bench')
  assert.equal(safeKey('a/b:c'), 'a_b_c')
  assert.equal(safeKey(''), 'x')
  assert.ok(safeKey('x'.repeat(100)).length <= 48)
})
