/**
 * `apply` and `rollback` against a throwaway layout: the junction flips, the record moves, and
 * a version that does not start is rolled back automatically.
 * @module dsh-upgrade/tests/apply
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readlinkSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..')
const cliPath = join(repoRoot, 'src', 'cli.ts')

/** Run the CLI. */
function run(args: readonly string[], cwd: string, env: Record<string, string> = {}): { status: number, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
  assert.equal(result.error, undefined, String(result.error))
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

/** Run git. */
function git(args: readonly string[], cwd: string): void {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

/** A free port. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0))
    })
  })
}

/**
 * Kill whatever serves a port.
 *
 * `apply` starts a real detached server on purpose, so a test that leaves it running would leak
 * a process and the port into every later run.
 * @param port - the port to evacuate.
 */
function stopPort(port: number): void {
  if (process.platform !== 'win32') return
  const listed = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true })
  for (const line of listed.stdout.split(/\r?\n/)) {
    if (!line.includes(`:${port} `) || !line.includes('LISTENING')) continue
    const pid = line.trim().split(/\s+/).at(-1)
    if (pid !== undefined) spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { encoding: 'utf8', windowsHide: true })
  }
}

/** Stand-in pnpm writing a serving entry that answers 200. */
const FAKE_PNPM = `
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [command, ...rest] = process.argv.slice(2)
if (command === 'install') process.exit(0)
if (command === 'run' && rest[0] === 'build') {
  const root = process.cwd()
  mkdirSync(join(root, 'apps', 'cli', 'lib'), { recursive: true })
  mkdirSync(join(root, '.dsh-build'), { recursive: true })
  writeFileSync(join(root, '.dsh-build', 'client-build-environment.json'), JSON.stringify({
    formatVersion: 1, environment: { DSH_CLIENT_VERSION: '0.0.0-fake' }, artifacts: { fileCount: 1 },
  }))
  writeFileSync(join(root, 'apps', 'cli', 'lib', 'bin.js'), [
    "import { createServer } from 'node:http'",
    "const at = process.argv.indexOf('--port')",
    'const port = Number(process.argv[at + 1] ?? 0)',
    "createServer((req, res) => { res.writeHead(200); res.end('ok') }).listen(port, '127.0.0.1', () => console.log('fake up ' + port))",
  ].join('\\n'))
  process.exit(0)
}
console.error('fake pnpm: unsupported ' + command)
process.exit(2)
`

/** Scratch layout with two tags. */
async function fixture(): Promise<{ root: string, fakePnpm: string, webPort: number }> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-apply-'))
  const origin = join(root, 'origin')
  mkdirSync(origin, { recursive: true })
  git(['init', '-b', 'main'], origin)
  writeFileSync(join(origin, 'package.json'), '{"name":"fixture","private":true}\n', 'utf8')
  git(['add', '.'], origin)
  git(['commit', '-m', 'initial'], origin)
  for (const tag of ['dsh-v0.2.1-rc.2', 'dsh-v0.2.1-rc.3']) git(['tag', tag], origin)
  const fakePnpm = join(root, 'fake-pnpm.mjs')
  writeFileSync(fakePnpm, FAKE_PNPM, 'utf8')
  const webPort = await freePort()
  writeFileSync(join(root, 'dsh-upgrade.json'), `${JSON.stringify({
    schema: 1, root, upstream: origin, tagPattern: 'dsh-v*', webPort, smokePort: await freePort(), profile: 'web',
  }, null, 2)}\n`, 'utf8')
  return { root, fakePnpm, webPort }
}

/** Read the state file. */
function state(root: string): { deployed: { tag: string, slot: string } | null, staged: unknown } {
  return JSON.parse(readFileSync(join(root, 'state', 'upgrade-state.json'), 'utf8')) as { deployed: { tag: string, slot: string } | null, staged: unknown }
}

test('apply flips the stable path, serves the staged slot, and records it', async (t) => {
  const { root, fakePnpm, webPort } = await fixture()
  t.after(() => stopPort(webPort))
  const env = { DSH_UPGRADE_PNPM_JS: fakePnpm, DSH_UPGRADE_START_TIMEOUT_MS: '8000' }
  assert.equal(run(['stage', '--tag', 'dsh-v0.2.1-rc.2', '--json'], root, env).status, 0)
  const applied = run(['apply', '--wait', '--json'], root, env)
  assert.equal(applied.status, 0)
  const report = JSON.parse(applied.stdout) as { ok: boolean, tag: string, slot: string, started: boolean }
  assert.equal(report.ok, true)
  assert.equal(report.tag, 'dsh-v0.2.1-rc.2')
  assert.equal(report.slot, 'a')
  assert.equal(report.started, true)
  const after = state(root)
  assert.equal(after.deployed?.tag, 'dsh-v0.2.1-rc.2')
  assert.equal(after.deployed?.slot, 'a')
  assert.equal(after.staged, null)
  const response = await fetch(`http://127.0.0.1:${webPort}/`)
  assert.equal(response.status, 200)
})

test('the default apply returns as soon as it schedules the switch, and the switch happens', async (t) => {
  const { root, fakePnpm, webPort } = await fixture()
  t.after(() => stopPort(webPort))
  const env = { DSH_UPGRADE_PNPM_JS: fakePnpm, DSH_UPGRADE_START_TIMEOUT_MS: '8000' }
  assert.equal(run(['stage', '--tag', 'dsh-v0.2.1-rc.2', '--json'], root, env).status, 0)

  const scheduled = run(['apply', '--json'], root, env)
  assert.equal(scheduled.status, 0, scheduled.stderr)
  const report = JSON.parse(scheduled.stdout) as { ok: boolean, detached: boolean, tag: string, slot: string }
  assert.equal(report.detached, true)
  assert.equal(report.tag, 'dsh-v0.2.1-rc.2')

  // The worker is a detached process: poll for the effect instead of assuming it happened.
  let deployed: string | undefined
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise(resolve => { setTimeout(resolve, 500) })
    try {
      deployed = state(root).deployed?.tag
    } catch {
      deployed = undefined
    }
    if (deployed === 'dsh-v0.2.1-rc.2') break
  }
  assert.equal(deployed, 'dsh-v0.2.1-rc.2', 'the detached worker must actually switch')
  const response = await fetch(`http://127.0.0.1:${webPort}/`)
  assert.equal(response.status, 200)
})

test('apply refuses a slot that was re-checked-out after staging', async (t) => {
  const { root, fakePnpm, webPort } = await fixture()
  t.after(() => stopPort(webPort))
  const env = { DSH_UPGRADE_PNPM_JS: fakePnpm, DSH_UPGRADE_START_TIMEOUT_MS: '8000' }
  assert.equal(run(['stage', '--tag', 'dsh-v0.2.1-rc.2', '--json'], root, env).status, 0)

  // A second release on its own commit, then the staged slot moved to it behind the tool's back.
  const origin = join(root, 'origin')
  writeFileSync(join(origin, 'file.txt'), 'next\n', 'utf8')
  git(['add', '.'], origin)
  git(['commit', '-m', 'next'], origin)
  git(['tag', 'dsh-v0.2.1-rc.4'], origin)
  const slot = join(root, 'dsh-slots', 'a')
  git(['fetch', '--tags', '--quiet', origin], slot)
  git(['checkout', '--detach', 'dsh-v0.2.1-rc.4'], slot)

  const refused = run(['apply', '--wait', '--json'], root, env)
  assert.equal(refused.status, 4)
  const report = JSON.parse(refused.stdout) as { ok: boolean, error: string }
  assert.equal(report.ok, false)
  assert.match(report.error, /no longer at dsh-v0\.2\.1-rc\.2/)
  assert.equal(state(root).deployed, null, 'nothing is recorded when the switch never happened')
})

test('a version that never answers is rolled back automatically', async (t) => {
  const { root, fakePnpm, webPort } = await fixture()
  t.after(() => stopPort(webPort))
  const env = { DSH_UPGRADE_PNPM_JS: fakePnpm, DSH_UPGRADE_START_TIMEOUT_MS: '3000' }

  // Serve rc.2 from slot a, then stage rc.3 into slot b (which smoke-tests fine).
  const firstStage = run(['stage', '--tag', 'dsh-v0.2.1-rc.2', '--json'], root, env)
  assert.equal(firstStage.status, 0, `stage1: ${firstStage.stderr}`)
  const firstApply = run(['apply', '--wait', '--no-start', '--json'], root, env)
  assert.equal(firstApply.status, 0, `apply1: ${firstApply.stderr}${firstApply.stdout}`)
  const secondStage = run(['stage', '--tag', 'dsh-v0.2.1-rc.3', '--json'], root, env)
  assert.equal(secondStage.status, 0, `stage2: ${secondStage.stderr}${secondStage.stdout}`)

  // A staged version that passes its smoke can still fail to start later (a missing runtime
  // dependency of the real DSH_HOME, a port race). Simulate exactly that by replacing the
  // built entry of the spare slot after staging.
  writeFileSync(join(root, 'dsh-slots', 'b', 'apps', 'cli', 'lib', 'bin.js'), 'process.exit(7)\n', 'utf8')

  const switched = run(['apply', '--wait', '--json'], root, env)
  assert.equal(switched.status, 4, `apply2: ${switched.stderr}${switched.stdout}`)
  const after = state(root)
  assert.equal(after.deployed?.tag, 'dsh-v0.2.1-rc.2', 'the previous version stays recorded')
  assert.match(readlinkSync(join(root, 'deepseek-harness')), /dsh-slots.a$/, 'the stable path points back at slot a')
})

test('a slot whose entry is missing is rolled back and the old version keeps serving', async () => {
  const { root, fakePnpm, webPort } = await fixture()
  const env = { DSH_UPGRADE_PNPM_JS: fakePnpm, DSH_UPGRADE_START_TIMEOUT_MS: '8000' }
  test.after(() => { spawnSync('taskkill', ['/PID', '0', '/T', '/F'], { windowsHide: true }); return stopPort(webPort) })
  assert.equal(run(['stage', '--tag', 'dsh-v0.2.1-rc.2', '--json'], root, env).status, 0)
  assert.equal(run(['apply', '--wait', '--json'], root, env).status, 0)
  assert.equal(run(['stage', '--tag', 'dsh-v0.2.1-rc.3', '--json'], root, env).status, 0)
  rmSync(join(root, 'dsh-slots', 'b', 'apps', 'cli', 'lib', 'bin.js'), { force: true })
  const failed = run(['apply', '--wait', '--json'], root, env)
  assert.equal(failed.status, 4, failed.stdout + failed.stderr)
  assert.equal(state(root).deployed?.tag, 'dsh-v0.2.1-rc.2')
  assert.match(readlinkSync(join(root, 'deepseek-harness')), /dsh-slots.a$/)
  const response = await fetch(`http://127.0.0.1:${webPort}/`)
  assert.equal(response.status, 200, 'the old version must be serving again')
})

test('start brings the serving slot up and stop frees the port', async () => {
  const { root, fakePnpm, webPort } = await fixture()
  const env = { DSH_UPGRADE_PNPM_JS: fakePnpm, DSH_UPGRADE_START_TIMEOUT_MS: '8000' }
  test.after(() => stopPort(webPort))
  assert.equal(run(['stage', '--tag', 'dsh-v0.2.1-rc.2', '--json'], root, env).status, 0)
  assert.equal(run(['apply', '--wait', '--no-start', '--json'], root, env).status, 0)

  const started = run(['start', '--json'], root, env)
  assert.equal(started.status, 0, started.stderr)
  assert.equal((await fetch(`http://127.0.0.1:${webPort}/`)).status, 200)

  const stopped = run(['stop', '--json'], root, env)
  assert.equal(stopped.status, 0, stopped.stderr)
  let free = false
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise(resolve => { setTimeout(resolve, 250) })
    if (!portBusy(webPort)) { free = true; break }
  }
  assert.equal(free, true, 'the port must be free after stop')
  assert.equal(run(['toggle', '--yes', '--json'], root, env).status, 0)
})

test('toggle refuses to stop without consent when there is no terminal', async () => {
  const { root, fakePnpm, webPort } = await fixture()
  const env = { DSH_UPGRADE_PNPM_JS: fakePnpm, DSH_UPGRADE_START_TIMEOUT_MS: '8000' }
  test.after(() => stopPort(webPort))
  assert.equal(run(['stage', '--tag', 'dsh-v0.2.1-rc.2', '--json'], root, env).status, 0)
  assert.equal(run(['apply', '--wait', '--json'], root, env).status, 0)
  const refused = run(['toggle', '--json'], root, env)
  assert.equal(refused.status, 3)
  assert.match(refused.stderr, /pass --yes/)
})

/** Whether something listens on a port. */
function portBusy(port: number): boolean {
  const result = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true })
  return result.stdout.split(/\r?\n/).some(line => line.includes(`:${port} `) && line.includes('LISTENING'))
}
