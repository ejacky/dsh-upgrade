/**
 * Safety primitives behind `stage`: process bounds, mutual exclusion, and link-safe deletes.
 * @module dsh-upgrade/tests/primitives
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLock } from '../src/engine/lock.ts'
import { runLogged } from '../src/engine/proc.ts'
import { removeTree } from '../src/engine/tree.ts'
import { applyPatches } from '../src/engine/patches.ts'
import { defaultConfig } from '../src/engine/config.ts'

/** Throwaway directory. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-upgrade-prim-'))
}

test('a command that outlives its budget is killed and reports a tail', async () => {
  const dir = scratch()
  const log = join(dir, 'sleep.log')
  const result = await runLogged({
    file: process.execPath,
    args: ['-e', "console.log('started'); setTimeout(() => {}, 60000)"],
    cwd: dir,
    logPath: log,
    timeoutMs: 600,
  })
  assert.equal(result.timedOut, true)
  assert.equal(result.code, -1)
  assert.ok(result.tail.some(line => line.includes('started')), `tail was ${result.tail.join(' | ')}`)
  assert.ok(existsSync(log))
})

test('a failed command keeps its trailing output', async () => {
  const dir = scratch()
  const result = await runLogged({
    file: process.execPath,
    args: ['-e', "console.error('boom'); process.exit(3)"],
    cwd: dir,
    logPath: join(dir, 'fail.log'),
    timeoutMs: 30_000,
  })
  assert.equal(result.code, 3)
  assert.equal(result.timedOut, false)
  assert.ok(result.tail.some(line => line.includes('boom')))
})

test('the lock excludes a second holder and is reusable after release', () => {
  const path = join(scratch(), 'stage.lock')
  const first = acquireLock(path)
  assert.notEqual(first, undefined)
  assert.equal(acquireLock(path), undefined)
  first?.release()
  const second = acquireLock(path)
  assert.notEqual(second, undefined)
  second?.release()
})

test('a stale lock from a dead process is reclaimed', () => {
  const path = join(scratch(), 'stage.lock')
  writeFileSync(path, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }), 'utf8')
  const lock = acquireLock(path)
  assert.notEqual(lock, undefined)
  lock?.release()
})

test('removeTree refuses paths outside the allowed roots', () => {
  const root = scratch()
  const outside = scratch()
  assert.throws(() => removeTree(outside, [root]), /refusing to delete/)
})

test('removeTree deletes a link without following it', () => {
  const root = scratch()
  const target = join(root, 'target')
  mkdirSync(target)
  writeFileSync(join(target, 'keep.txt'), 'keep', 'utf8')
  const victim = join(root, 'victim')
  mkdirSync(victim)
  const link = join(victim, 'link')
  symlinkSync(target, link, 'junction')
  removeTree(victim, [root])
  assert.equal(existsSync(victim), false)
  assert.equal(existsSync(join(target, 'keep.txt')), true, 'the link target must survive')
})

test('patches apply cleanly and failures are reported', () => {
  const root = scratch()
  const slot = join(root, 'slot')
  mkdirSync(slot)
  const git = (args: readonly string[]): void => {
    const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { cwd: slot, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  git(['init', '-b', 'main'])
  writeFileSync(join(slot, 'file.txt'), 'one\n', 'utf8')
  git(['add', '.'])
  git(['commit', '-m', 'base'])
  const patch = join(root, 'change.patch')
  writeFileSync(patch, [
    'diff --git a/file.txt b/file.txt',
    '--- a/file.txt',
    '+++ b/file.txt',
    '@@ -1 +1 @@',
    '-one',
    '+two',
    '',
  ].join('\n'), 'utf8')

  const patched = applyPatches({ ...defaultConfig({ root }), patchFiles: [patch] }, slot, root, () => {})
  assert.equal(patched.ok, true, patched.error)

  const missing = applyPatches({ ...defaultConfig({ root }), patchFiles: [join(root, 'absent.patch')] }, slot, root, () => {})
  assert.equal(missing.ok, false)
  assert.match(missing.error ?? '', /patch not found/)
  assert.equal(readdirSync(slot).length > 0, true)
})
