/**
 * `stage` against a throwaway repository with a stand-in package manager.
 *
 * The stand-in keeps the test fast and offline while still exercising the real sequence:
 * clone, checkout, install, build, run the built entry, probe it, and record the result.
 *
 * @module dsh-upgrade/tests/stage
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..')
const cliPath = join(repoRoot, 'src', 'cli.ts')

/** Run the CLI with extra environment. */
function run(args: readonly string[], cwd: string, env: Record<string, string> = {}): { status: number, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`)
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

/** Run git, failing the test on error. */
function git(args: readonly string[], cwd: string): void {
  const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@localhost', ...args], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
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

/** The stand-in package manager: `install` succeeds, `run build` writes the artifacts. */
const FAKE_PNPM = `
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [command, ...rest] = process.argv.slice(2)
if (command === 'install') process.exit(0)
if (command === 'run' && rest[0] === 'build') {
  if (process.env.FAKE_BUILD_FAIL === '1') { console.error('fake build failed'); process.exit(1) }
  const root = process.cwd()
  mkdirSync(join(root, '.dsh-build'), { recursive: true })
  writeFileSync(join(root, '.dsh-build', 'client-build-environment.json'), JSON.stringify({
    formatVersion: 1,
    environment: { DSH_CLIENT_VERSION: '0.0.0-fake' },
    artifacts: { fileCount: 3 },
  }))
  mkdirSync(join(root, 'apps', 'cli', 'lib'), { recursive: true })
  writeFileSync(join(root, 'apps', 'cli', 'lib', 'bin.js'), [
    "import { createServer } from 'node:http'",
    "const at = process.argv.indexOf('--port')",
    'const port = Number(process.argv[at + 1] ?? 0)',
    "const server = createServer((req, res) => { res.writeHead(200); res.end('ok') })",
    "server.listen(port, '127.0.0.1', () => console.log('fake web listening on ' + port))",
  ].join('\\n'))
  process.exit(0)
}
console.error('fake pnpm: unsupported ' + command)
process.exit(2)
`

/** Build a scratch layout and return its paths. */
async function fixture(manualBuild = false): Promise<{ root: string, origin: string, fakePnpm: string, smokePort: number }> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-stage-'))
  const origin = join(root, 'origin')
  mkdirSync(origin, { recursive: true })
  git(['init', '-b', 'main'], origin)
  writeFileSync(join(origin, 'package.json'), '{"name":"fixture","private":true}\n', 'utf8')
  git(['add', '.'], origin)
  git(['commit', '-m', 'initial'], origin)
  for (const tag of ['dsh-v0.2.1-rc.2', 'dsh-v0.2.1-rc.3']) git(['tag', tag], origin)

  const fakePnpm = join(root, 'fake-pnpm.mjs')
  writeFileSync(fakePnpm, FAKE_PNPM, 'utf8')
  const smokePort = await freePort()
  writeFileSync(join(root, 'dsh-upgrade.json'), `${JSON.stringify({
    schema: 1,
    root,
    upstream: origin,
    tagPattern: 'dsh-v*',
    webPort: await freePort(),
    smokePort,
    profile: 'web',
    manualBuild,
  }, null, 2)}\n`, 'utf8')
  return { root, origin, fakePnpm, smokePort }
}

test('stage clones the first slot, builds, smokes, and records it as staged', async () => {
  const { root, fakePnpm } = await fixture()
  const staged = run(['stage', '--json'], root, { DSH_UPGRADE_PNPM_JS: fakePnpm })
  assert.equal(staged.status, 0, staged.stderr)
  const report = JSON.parse(staged.stdout) as { ok: boolean, tag: string, slot: string, smoke: boolean, clientVersion: string }
  assert.equal(report.ok, true)
  assert.equal(report.tag, 'dsh-v0.2.1-rc.3')
  assert.equal(report.slot, 'a')
  assert.equal(report.smoke, true)
  assert.equal(report.clientVersion, '0.0.0-fake')
  assert.ok(existsSync(join(root, 'dsh-slots', 'a', 'apps', 'cli', 'lib', 'bin.js')))

  const state = JSON.parse(readFileSync(join(root, 'state', 'upgrade-state.json'), 'utf8')) as { staged: { tag: string } }
  assert.equal(state.staged.tag, 'dsh-v0.2.1-rc.3')

  const again = run(['stage', '--json'], root, { DSH_UPGRADE_PNPM_JS: fakePnpm })
  assert.equal(again.status, 0, again.stderr)
  assert.equal((JSON.parse(again.stdout) as { alreadyPrepared: boolean }).alreadyPrepared, true)
})

test('a failing build records the error and stages nothing', async () => {
  const { root, fakePnpm } = await fixture()
  const failed = run(['stage', '--json'], root, { DSH_UPGRADE_PNPM_JS: fakePnpm, FAKE_BUILD_FAIL: '1' })
  assert.equal(failed.status, 4)
  const report = JSON.parse(failed.stdout) as { ok: boolean, error: string }
  assert.equal(report.ok, false)
  assert.match(report.error, /pnpm run build failed/)
  const state = JSON.parse(readFileSync(join(root, 'state', 'upgrade-state.json'), 'utf8')) as { staged: unknown, lastError: string }
  assert.equal(state.staged, null)
  assert.match(state.lastError, /build failed/)
})

test('manualBuild stops before building and asks for a human', async () => {
  const { root, fakePnpm } = await fixture(true)
  const stopped = run(['stage', '--json'], root, { DSH_UPGRADE_PNPM_JS: fakePnpm })
  assert.equal(stopped.status, 3)
  assert.ok(existsSync(join(root, 'state', 'build-request.json')))
  const request = JSON.parse(readFileSync(join(root, 'state', 'build-request.json'), 'utf8')) as { tag: string, slot: string }
  assert.equal(request.tag, 'dsh-v0.2.1-rc.3')
  assert.equal(request.slot, 'a')
})

test('stage --resume finishes a build that ran in an administrator console', async () => {
  const { root, fakePnpm } = await fixture(true)
  const stopped = run(['stage', '--json'], root, { DSH_UPGRADE_PNPM_JS: fakePnpm })
  assert.equal(stopped.status, 3)

  // What the elevated console does: build the slot that the request names.
  const slot = join(root, 'dsh-slots', 'a')
  const built = spawnSync(process.execPath, [fakePnpm, 'run', 'build'], { cwd: slot, encoding: 'utf8' })
  assert.equal(built.status, 0, built.stderr)

  const resumed = run(['stage', '--resume', '--json'], root, { DSH_UPGRADE_PNPM_JS: fakePnpm })
  assert.equal(resumed.status, 0, resumed.stderr)
  const report = JSON.parse(resumed.stdout) as { ok: boolean, resumed: boolean, tag: string, slot: string, smoke: boolean }
  assert.equal(report.ok, true)
  assert.equal(report.resumed, true)
  assert.equal(report.tag, 'dsh-v0.2.1-rc.3')
  assert.equal(report.slot, 'a')
  assert.equal(report.smoke, true)

  const state = JSON.parse(readFileSync(join(root, 'state', 'upgrade-state.json'), 'utf8')) as { staged: { tag: string, clientVersion?: string }, lastError: unknown }
  assert.equal(state.staged.tag, 'dsh-v0.2.1-rc.3')
  assert.equal(state.staged.clientVersion, '0.0.0-fake')
  assert.equal(state.lastError, null)
  assert.equal(existsSync(join(root, 'state', 'build-request.json')), false)
})

test('stage --resume refuses a request whose build has not happened', async () => {
  const { root, fakePnpm } = await fixture(true)
  const stopped = run(['stage', '--json'], root, { DSH_UPGRADE_PNPM_JS: fakePnpm })
  assert.equal(stopped.status, 3)

  const resumed = run(['stage', '--resume', '--json'], root, { DSH_UPGRADE_PNPM_JS: fakePnpm })
  assert.equal(resumed.status, 3)
  const report = JSON.parse(resumed.stdout) as { ok: boolean, error: string }
  assert.equal(report.ok, false)
  assert.match(report.error, /the build has not finished/)
})

test('stage --resume without a request asks for a normal stage', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-resume-'))
  writeFileSync(join(root, 'dsh-upgrade.json'), `${JSON.stringify({ schema: 1, root }, null, 2)}\n`, 'utf8')
  const resumed = run(['stage', '--resume', '--json'], root)
  assert.equal(resumed.status, 3)
  assert.match((JSON.parse(resumed.stdout) as { error: string }).error, /no build request/)
})

test('stage refuses a tag that is not newer than the deployed version', async () => {
  const { root, fakePnpm } = await fixture()
  mkdirSync(join(root, 'state'), { recursive: true })
  writeFileSync(join(root, 'state', 'upgrade-state.json'), `${JSON.stringify({
    schema: 1,
    deployed: { tag: 'dsh-v0.2.1-rc.3', slot: 'a', at: new Date().toISOString() },
    staged: null,
    lastCheck: null,
    lastError: null,
    history: [],
  }, null, 2)}\n`, 'utf8')

  const refused = run(['stage', '--tag', 'dsh-v0.2.1-rc.2', '--json'], root, { DSH_UPGRADE_PNPM_JS: fakePnpm })
  assert.equal(refused.status, 3)
  const report = JSON.parse(refused.stdout) as { ok: boolean, error: string }
  assert.match(report.error, /not newer than the deployed dsh-v0\.2\.1-rc\.3/)

  const forced = run(['stage', '--tag', 'dsh-v0.2.1-rc.2', '--force', '--json'], root, { DSH_UPGRADE_PNPM_JS: fakePnpm })
  assert.equal(forced.status, 0, forced.stderr)
})

test('stage refuses to run without a configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-nocfg-'))
  const result = run(['stage'], root)
  assert.equal(result.status, 4)
  assert.match(result.stderr, /run "dsh-upgrade init"/)
})
