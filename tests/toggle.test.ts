/**
 * `toggle` consent: a desktop launcher has no terminal, so it asks in a dialog.
 *
 * The dialog tool is faked on `PATH`; the tests assert the decision it produces (proceed, keep
 * running, or refuse when no tool exists) rather than any window. A stop is proven by the port.
 *
 * @module dsh-upgrade/tests/toggle
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { portFree } from '../src/engine/host.ts'
import { skipUnlessPosix, stopPort } from './helpers/platform.ts'

const repoRoot = join(import.meta.dirname, '..')
const cliPath = join(repoRoot, 'src', 'cli.ts')

/**
 * Run the CLI with an isolated PATH and display environment.
 * @param args - CLI arguments.
 * @param cwd - fixture root.
 * @param env - environment overrides.
 * @returns the exit code and captured streams.
 */
function run(args: readonly string[], cwd: string, env: Record<string, string> = {}): { status: number, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '', ...env },
  })
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`)
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

/** A free localhost port. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** A scratch layout with a configuration. */
async function fixture(): Promise<{ root: string, port: number }> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-toggle-'))
  const port = await freePort()
  writeFileSync(join(root, 'dsh-upgrade.json'), `${JSON.stringify({ schema: 1, root, webPort: port, smokePort: await freePort() }, null, 2)}\n`, 'utf8')
  return { root, port }
}

/**
 * Create a fake dialog tool that answers yes or no.
 * @param parent - directory that receives the `bin` folder.
 * @param answer - `0` for yes, `1` for no.
 * @returns the `bin` directory.
 */
function fakeDialog(parent: string, answer: number): string {
  const bin = join(parent, 'fake-bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'zenity'), `#!/bin/sh\nexit ${answer}\n`, 'utf8')
  chmodSync(join(bin, 'zenity'), 0o755)
  return bin
}

/** A child that serves a port, so a stop has something real to end. */
async function serveOn(port: number): Promise<void> {
  const script = `require('node:http').createServer((request, response) => { response.end('ok') }).listen(${port}, '127.0.0.1')`
  spawn(process.execPath, ['-e', script], { stdio: 'ignore', detached: true })
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && await portFree(port)) {
    await new Promise(resolve => { setTimeout(resolve, 50) })
  }
}

test('a stop with no dialog tool refuses instead of pretending', async (t) => {
  if (skipUnlessPosix(t)) return
  const { root, port } = await fixture()
  await serveOn(port)
  t.after(() => stopPort(port))
  const empty = join(root, 'empty-bin')
  mkdirSync(empty, { recursive: true })
  const refused = run(['toggle', '--json'], root, { PATH: empty, DISPLAY: ':0' })
  assert.equal(refused.status, 3, refused.stderr)
  const report = JSON.parse(refused.stdout) as { ok: boolean, error: string, nextAction: string }
  assert.equal(report.ok, false)
  assert.equal(report.nextAction, 'human')
  assert.match(report.error, /no dialog tool/)
  assert.match(report.error, /--yes/)
  assert.equal(await portFree(port), false, 'a refused stop must leave the server serving')
})

test('a "No" in the dialog keeps the server running', async (t) => {
  if (skipUnlessPosix(t)) return
  const { root, port } = await fixture()
  await serveOn(port)
  t.after(() => stopPort(port))
  const bin = fakeDialog(root, 1)
  const answered = run(['toggle'], root, { PATH: bin, DISPLAY: ':0' })
  assert.equal(answered.status, 0, answered.stderr)
  assert.match(answered.stdout, /kept running/)
  assert.equal(await portFree(port), false, 'the server must still answer')
})

test('a "Yes" in the dialog stops the server', async (t) => {
  if (skipUnlessPosix(t)) return
  const { root, port } = await fixture()
  await serveOn(port)
  t.after(() => stopPort(port))
  const bin = fakeDialog(root, 0)
  const answered = run(['toggle'], root, { PATH: bin, DISPLAY: ':0' })
  assert.equal(answered.status, 0, answered.stderr)
  assert.equal(await portFree(port), true, 'the port must be free after a confirmed stop')
})

test('starting from a launcher also asks first', async (t) => {
  if (skipUnlessPosix(t)) return
  const { root } = await fixture()
  const bin = fakeDialog(root, 1)
  const answered = run(['toggle'], root, { PATH: bin, DISPLAY: ':0' })
  assert.equal(answered.status, 0, answered.stderr)
  assert.match(answered.stdout, /kept stopped/)

  const confirmed = run(['toggle'], root, { PATH: fakeDialog(root, 0), DISPLAY: ':0' })
  assert.equal(confirmed.status, 4, 'a confirmed start proceeds, then finds no serving slot')
  assert.match(confirmed.stderr, /not a slot link/)
})

test('--yes skips the dialog, and a headless start does not block', async (t) => {
  if (skipUnlessPosix(t)) return
  const { root } = await fixture()
  const direct = run(['toggle', '--yes'], root, { PATH: join(root, 'nothing'), DISPLAY: '' })
  assert.equal(direct.status, 4, direct.stderr)

  const headless = run(['toggle'], root, { PATH: join(root, 'nothing'), DISPLAY: '' })
  assert.equal(headless.status, 4, 'without a display there is nobody to ask; starting still works')
})
