/**
 * `log`: the tail of a recorded step, and what exists to read.
 *
 * The ordering test sets modification times explicitly: a log viewer that picks the wrong file
 * because two writes landed in the same millisecond would be useless exactly when someone
 * needs it.
 *
 * @module dsh-upgrade/tests/log
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..')
const cliPath = join(repoRoot, 'src', 'cli.ts')

/** Run the CLI in a directory. */
function run(args: readonly string[], cwd: string): { status: number, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8' })
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`)
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

/** A layout with two logs of known age. */
function fixture(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-log-'))
  writeFileSync(join(root, 'dsh-upgrade.json'), `${JSON.stringify({ schema: 1, root }, null, 2)}\n`, 'utf8')
  const logs = join(root, 'logs')
  mkdirSync(logs, { recursive: true })
  const older = join(logs, 'stage-dsh-v0.2.1-rc.3.log')
  writeFileSync(older, `${Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join('\n')}\n`, 'utf8')
  const newer = join(logs, 'watch.log')
  writeFileSync(newer, 'first\nsecond\nthird\n', 'utf8')
  const now = Date.now() / 1000
  utimesSync(older, now - 600, now - 600)
  utimesSync(newer, now, now)
  return { root }
}

test('log prints the tail of the newest log', () => {
  const { root } = fixture()
  const read = run(['log', '--json', '--tail', '3'], root)
  assert.equal(read.status, 0, read.stderr)
  const report = JSON.parse(read.stdout) as { ok: boolean, name: string, lines: string[] }
  assert.equal(report.ok, true)
  assert.equal(report.name, 'watch.log')
  assert.deepEqual(report.lines, ['first', 'second', 'third'])
})

test('log --file reads a named log and honours --tail', () => {
  const { root } = fixture()
  const read = run(['log', '--json', '--file', 'stage-dsh-v0.2.1-rc.3.log', '--tail', '2'], root)
  assert.equal(read.status, 0, read.stderr)
  const report = JSON.parse(read.stdout) as { name: string, lines: string[] }
  assert.equal(report.name, 'stage-dsh-v0.2.1-rc.3.log')
  assert.deepEqual(report.lines, ['line 59', 'line 60'])
})

test('log --list reports the files newest first', () => {
  const { root } = fixture()
  const listed = run(['log', '--list', '--json'], root)
  assert.equal(listed.status, 0, listed.stderr)
  const report = JSON.parse(listed.stdout) as { ok: boolean, directory: string, files: { name: string, bytes: number, modified: string }[] }
  assert.equal(report.ok, true)
  assert.deepEqual(report.files.map(file => file.name), ['watch.log', 'stage-dsh-v0.2.1-rc.3.log'])
  assert.equal(report.files[0]?.bytes, 19)
  assert.match(report.files[0]?.modified ?? '', /^\d{4}-\d\d-\d\dT/)

  const text = run(['log', '--list'], root)
  assert.equal(text.status, 0)
  assert.match(text.stdout, /watch\.log/)
})

test('log reports the failures a person can act on', () => {
  const { root } = fixture()
  const unknown = run(['log', '--file', 'absent.log', '--json'], root)
  assert.equal(unknown.status, 4)
  assert.match((JSON.parse(unknown.stdout) as { error: string }).error, /no log named absent\.log/)

  const badTail = run(['log', '--tail', '0'], root)
  assert.equal(badTail.status, 2)
  assert.match(badTail.stderr, /positive line count/)

  const empty = mkdtempSync(join(tmpdir(), 'dsh-upgrade-log-empty-'))
  writeFileSync(join(empty, 'dsh-upgrade.json'), `${JSON.stringify({ schema: 1, root: empty })}\n`, 'utf8')
  const none = run(['log', '--json'], empty)
  assert.equal(none.status, 4)
  assert.match((JSON.parse(none.stdout) as { error: string }).error, /no logs yet/)
})
