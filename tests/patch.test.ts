/**
 * `patch`: the configured patch list, checked against a real checkout.
 *
 * Every test drives the CLI against a throwaway repository so the behaviour under test is
 * the behaviour an operator gets: which patches are configured, whether they still apply,
 * and that a patch which no longer applies stops a stage instead of shipping.
 *
 * @module dsh-upgrade/tests/patch
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..')
const cliPath = join(repoRoot, 'src', 'cli.ts')

/** Run the CLI and capture its streams and exit code. */
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

/** The stand-in package manager: staging must never reach a real install in these tests. */
const FAKE_PNPM = `
console.error('fake pnpm: no install expected in the patch tests')
process.exit(1)
`

/** Stand-in package manager that produces the artifacts a smoke test needs. */
const FAKE_PNPM_OK = `
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [command, ...rest] = process.argv.slice(2)
if (command === 'install') process.exit(0)
if (command === 'run' && rest[0] === 'build') {
  const root = process.cwd()
  mkdirSync(join(root, '.dsh-build'), { recursive: true })
  writeFileSync(join(root, '.dsh-build', 'client-build-environment.json'), JSON.stringify({
    environment: { DSH_CLIENT_VERSION: '0.0.0-fake' },
    artifacts: { fileCount: 3 },
  }))
  mkdirSync(join(root, 'apps', 'cli', 'lib'), { recursive: true })
  writeFileSync(join(root, 'apps', 'cli', 'lib', 'bin.js'), [
    "import { createServer } from 'node:http'",
    "const at = process.argv.indexOf('--port')",
    'const port = Number(process.argv[at + 1] ?? 0)',
    "createServer((req, res) => { res.writeHead(200); res.end('ok') })",
    ".listen(port, '127.0.0.1', () => console.log('fake web listening on ' + port))",
  ].join('\\n'))
  process.exit(0)
}
console.error('fake pnpm: unsupported ' + command)
process.exit(2)
`

/** Write the stand-in package manager into a fixture and return its path. */
function fakePnpmIn(root: string): string {
  const path = join(root, 'fake-pnpm.mjs')
  writeFileSync(path, FAKE_PNPM_OK, 'utf8')
  return path
}

/** A free localhost port, so a live server on the default port cannot confuse a stage. */
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

/** Paths a patch test needs. */
interface Fixture {
  readonly root: string
  readonly slot: string
  readonly manifest: string
  readonly good: string
  readonly conflict: string
  readonly configPath: string
}

/**
 * Build a throwaway layout: one upstream tag, one slot at that tag, one applicable patch,
 * one conflicting patch, and a catalog that names both.
 * @param patchFiles - patch list to write into the configuration.
 */
async function fixture(patchFiles: readonly string[] = []): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-patch-'))
  const origin = join(root, 'origin')
  mkdirSync(origin, { recursive: true })
  git(['init', '-b', 'main'], origin)
  writeFileSync(join(origin, 'file.txt'), 'one\n', 'utf8')
  git(['add', '.'], origin)
  git(['commit', '-m', 'initial'], origin)
  git(['tag', 'dsh-v0.2.1-rc.3'], origin)

  const slot = join(root, 'dsh-slots', 'a')
  mkdirSync(join(root, 'dsh-slots'), { recursive: true })
  git(['clone', origin, slot], root)
  git(['checkout', '--detach', 'dsh-v0.2.1-rc.3'], slot)

  const good = join(root, 'good.patch')
  writeFileSync(good, [
    'diff --git a/file.txt b/file.txt',
    '--- a/file.txt',
    '+++ b/file.txt',
    '@@ -1 +1 @@',
    '-one',
    '+two',
    '',
  ].join('\n'), 'utf8')
  const conflict = join(root, 'conflict.patch')
  writeFileSync(conflict, [
    'diff --git a/file.txt b/file.txt',
    '--- a/file.txt',
    '+++ b/file.txt',
    '@@ -1 +1 @@',
    '-nothing',
    '+something',
    '',
  ].join('\n'), 'utf8')

  const manifest = join(root, 'manifest.json')
  writeFileSync(manifest, `${JSON.stringify({
    schema: 1,
    patches: [
      { name: 'good', file: good, summary: 'renames the marker', verifiedTags: ['dsh-v0.2.1-rc.3'] },
      { name: 'broken', file: conflict, summary: 'a patch that no longer applies', obsoleteSince: 'dsh-v9.0.0' },
    ],
  }, null, 2)}\n`, 'utf8')

  const configPath = join(root, 'dsh-upgrade.json')
  writeFileSync(configPath, `${JSON.stringify({
    schema: 1,
    root,
    upstream: origin,
    tagPattern: 'dsh-v*',
    webPort: await freePort(),
    smokePort: await freePort(),
    patchFiles,
    keepMe: { untouched: true },
  }, null, 2)}\n`, 'utf8')
  return { root, slot, manifest, good, conflict, configPath }
}

/** Read the configuration file as raw JSON. */
function readConfig(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

test('patch list shows catalogued and configured patches as JSON', async () => {
  const { root, manifest } = await fixture()
  const listed = run(['patch', 'list', '--json', '--manifest', manifest], root)
  assert.equal(listed.status, 0, listed.stderr)
  const report = JSON.parse(listed.stdout) as {
    manifest: { present: boolean, count: number }
    active: string[]
    patches: { name: string, active: boolean, exists: boolean, verifiedTags: string[], obsoleteSince: string | null }[]
  }
  assert.equal(report.manifest.present, true)
  assert.equal(report.manifest.count, 2)
  assert.deepEqual(report.active, [])
  assert.deepEqual(report.patches.map(patch => patch.name), ['good', 'broken'])
  assert.equal(report.patches[0]?.active, false)
  assert.equal(report.patches[0]?.exists, true)
  assert.deepEqual(report.patches[0]?.verifiedTags, ['dsh-v0.2.1-rc.3'])
  assert.equal(report.patches[1]?.obsoleteSince, 'dsh-v9.0.0')
})

test('patch add and remove touch only patchFiles and are idempotent', async () => {
  const { root, manifest, good } = await fixture()
  const added = run(['patch', 'add', 'good', '--json', '--manifest', manifest], root)
  assert.equal(added.status, 0, added.stderr)
  const first = JSON.parse(added.stdout) as { file: string, patchFiles: string[] }
  assert.deepEqual(first.patchFiles, [good])

  const again = run(['patch', 'add', 'good', '--json', '--manifest', manifest], root)
  assert.equal(again.status, 0, again.stderr)
  assert.equal((JSON.parse(again.stdout) as { alreadyActive: boolean }).alreadyActive, true)

  const config = readConfig(join(root, 'dsh-upgrade.json'))
  assert.deepEqual(config['patchFiles'], [good])
  assert.deepEqual(config['keepMe'], { untouched: true }, 'unknown keys must survive an edit')

  const removed = run(['patch', 'remove', 'good', '--json', '--manifest', manifest], root)
  assert.equal(removed.status, 0, removed.stderr)
  assert.deepEqual((JSON.parse(removed.stdout) as { patchFiles: string[] }).patchFiles, [])
  const twice = run(['patch', 'remove', 'good', '--json', '--manifest', manifest], root)
  assert.equal(twice.status, 0, twice.stderr)
  assert.equal((JSON.parse(twice.stdout) as { wasActive: boolean }).wasActive, false)
})

test('patch add accepts a patch path outside the catalog and rejects a non-patch', async () => {
  const { root, good } = await fixture()
  const added = run(['patch', 'add', '--file', good, '--json'], root)
  assert.equal(added.status, 0, added.stderr)
  assert.deepEqual(readConfig(join(root, 'dsh-upgrade.json'))['patchFiles'], [good])

  const notes = join(root, 'notes.txt')
  writeFileSync(notes, 'just text\n', 'utf8')
  const rejected = run(['patch', 'add', '--file', notes], root)
  assert.equal(rejected.status, 2)
  assert.match(rejected.stderr, /does not look like a git patch/)

  const absent = run(['patch', 'add', '--file', join(root, 'absent.patch')], root)
  assert.equal(absent.status, 2)
  assert.match(absent.stderr, /no patch file at/)
})

test('patch verify reports applies, applied, and conflict against the serving tree', async () => {
  const { root, manifest, good } = await fixture()
  const applicable = run(['patch', 'verify', '--json', '--manifest', manifest], root)
  assert.equal(applicable.status, 0, applicable.stderr)
  assert.deepEqual((JSON.parse(applicable.stdout) as { checks: { state: string }[] }).checks, [])

  const added = run(['patch', 'add', 'good', '--json', '--manifest', manifest], root)
  assert.equal(added.status, 0, added.stderr)
  const applies = run(['patch', 'verify', '--json', '--manifest', manifest], root)
  assert.equal(applies.status, 0, applies.stderr)
  const appliesReport = JSON.parse(applies.stdout) as { ok: boolean, tree: { slot: string, tag: string }, checks: { name: string, state: string }[] }
  assert.equal(appliesReport.tree.slot, 'a')
  assert.equal(appliesReport.tree.tag, 'dsh-v0.2.1-rc.3')
  assert.equal(appliesReport.checks[0]?.state, 'applies')

  git(['apply', good], join(root, 'dsh-slots', 'a'))
  const already = run(['patch', 'verify', '--json', '--manifest', manifest], root)
  assert.equal(already.status, 0, already.stderr)
  assert.equal((JSON.parse(already.stdout) as { checks: { state: string }[] }).checks[0]?.state, 'applied')

  const added2 = run(['patch', 'add', 'broken', '--json', '--manifest', manifest], root)
  assert.equal(added2.status, 0, added2.stderr)
  const conflicted = run(['patch', 'verify', '--json', '--manifest', manifest], root)
  assert.equal(conflicted.status, 3)
  const conflictReport = JSON.parse(conflicted.stdout) as { ok: boolean, checks: { name: string, state: string }[] }
  assert.equal(conflictReport.ok, false)
  assert.deepEqual(conflictReport.checks.map(check => check.state), ['applied', 'conflict'])
})

test('patch verify --all reports catalog entries that are not applied without failing them', async () => {
  const { root, manifest } = await fixture()
  const verified = run(['patch', 'verify', '--all', '--json', '--manifest', manifest], root)
  assert.equal(verified.status, 0, verified.stderr)
  const report = JSON.parse(verified.stdout) as { ok: boolean, checks: { name: string, active: boolean, state: string }[] }
  assert.equal(report.ok, true)
  assert.deepEqual(report.checks.map(check => check.active), [false, false])
  assert.deepEqual(report.checks.map(check => check.state), ['applies', 'conflict'])
})

test('patch verify without a checkout asks for a stage instead of guessing', async () => {
  const { root, manifest } = await fixture()
  rmSync(join(root, 'dsh-slots'), { recursive: true, force: true })
  const verified = run(['patch', 'verify', '--json', '--manifest', manifest], root)
  assert.equal(verified.status, 4)
  const report = JSON.parse(verified.stdout) as { ok: boolean, error: string }
  assert.equal(report.ok, false)
  assert.match(report.error, /no slot checkout under/)
})

test('a configured patch that conflicts stops stage and records the reason', async () => {
  const { root, conflict } = await fixture()
  const added = run(['patch', 'add', '--file', conflict, '--json'], root)
  assert.equal(added.status, 0, added.stderr)
  const fakePnpm = join(root, 'fake-pnpm.mjs')
  writeFileSync(fakePnpm, FAKE_PNPM, 'utf8')
  const staged = run(['stage', '--json'], root, { DSH_UPGRADE_PNPM_JS: fakePnpm })
  assert.equal(staged.status, 3, staged.stderr)
  const report = JSON.parse(staged.stdout) as { ok: boolean, error: string, nextAction: string }
  assert.equal(report.ok, false)
  assert.match(report.error, /does not apply to dsh-v0\.2\.1-rc\.3/)
  assert.match(report.error, /patch remove/)
  assert.equal(report.nextAction, 'human')
  const state = JSON.parse(readFileSync(join(root, 'state', 'upgrade-state.json'), 'utf8')) as { staged: unknown, lastError: string }
  assert.equal(state.staged, null)
  assert.match(state.lastError, /does not apply/)
  assert.equal(existsSync(join(root, 'dsh-slots', 'a', '.dsh-build')), false)
})

test('stage re-prepares a slot when a patch was added after it was prepared', async () => {
  const { root, slot, good } = await fixture()
  const fakePnpm = fakePnpmIn(root)

  const first = run(['stage', '--json'], root, { DSH_UPGRADE_PNPM_JS: fakePnpm })
  assert.equal(first.status, 0, first.stderr)
  assert.equal(readFileSync(join(slot, 'file.txt'), 'utf8').trim(), 'one')

  const added = run(['patch', 'add', '--file', good, '--json'], root)
  assert.equal(added.status, 0, added.stderr)

  const second = run(['stage', '--json'], root, { DSH_UPGRADE_PNPM_JS: fakePnpm })
  assert.equal(second.status, 0, second.stderr)
  const report = JSON.parse(second.stdout) as { tag: string, alreadyPrepared?: boolean, patches: { applied: string[] } }
  assert.equal(report.alreadyPrepared, undefined, 'a configured patch must defeat the prepared shortcut')
  assert.deepEqual(report.patches.applied, [good])
  assert.equal(readFileSync(join(slot, 'file.txt'), 'utf8').trim(), 'two', 'the staged tree must carry the patch')
  const state = JSON.parse(readFileSync(join(root, 'state', 'upgrade-state.json'), 'utf8')) as { staged: { tag: string } }
  assert.equal(state.staged.tag, 'dsh-v0.2.1-rc.3')
})

test('several patches that touch one file all apply in one stage', async () => {
  const { root, slot } = await fixture()
  const fakePnpm = fakePnpmIn(root)
  const second = join(root, 'second.patch')
  writeFileSync(second, [
    'diff --git a/file.txt b/file.txt',
    '--- a/file.txt',
    '+++ b/file.txt',
    '@@ -1 +1 @@',
    '-two',
    '+three',
    '',
  ].join('\n'), 'utf8')
  const good = join(root, 'good.patch')
  for (const patch of [good, second]) {
    const added = run(['patch', 'add', '--file', patch, '--json'], root)
    assert.equal(added.status, 0, added.stderr)
  }
  const staged = run(['stage', '--json'], root, { DSH_UPGRADE_PNPM_JS: fakePnpm })
  assert.equal(staged.status, 0, staged.stderr)
  const report = JSON.parse(staged.stdout) as { patches: { applied: string[], alreadyApplied: string[] } }
  assert.deepEqual(report.patches.applied, [good, second])
  assert.equal(readFileSync(join(slot, 'file.txt'), 'utf8').trim(), 'three')
})

test('patch remove matches a path spelled differently', async () => {
  const { root, good } = await fixture()
  const added = run(['patch', 'add', '--file', good, '--json'], root)
  assert.equal(added.status, 0, added.stderr)

  const spelled = `${root}\\.\\good.patch`
  const removed = run(['patch', 'remove', '--file', spelled, '--json'], root)
  assert.equal(removed.status, 0, removed.stderr)
  assert.deepEqual((JSON.parse(removed.stdout) as { patchFiles: string[] }).patchFiles, [])

  const again = run(['patch', 'add', '--file', spelled, '--json'], root)
  assert.equal(again.status, 0, again.stderr)
  const listed = JSON.parse(again.stdout) as { patchFiles: string[] }
  assert.equal(listed.patchFiles.length, 1, 'one file must not be listed twice')
  const stored = listed.patchFiles[0] ?? ''
  assert.equal(realpathSync.native(stored).toLowerCase(), realpathSync.native(good).toLowerCase())
})

test('a malformed patchFiles value is reported with the documented code', async () => {
  const { root } = await fixture()
  const configPath = join(root, 'dsh-upgrade.json')
  const config = readConfig(configPath)
  config['patchFiles'] = 'x.patch'
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

  const listed = run(['patch', 'list', '--json'], root)
  assert.equal(listed.status, 4)
  const report = JSON.parse(listed.stdout) as { ok: boolean, error: string }
  assert.equal(report.ok, false)
  assert.match(report.error, /array of strings/)
  assert.ok(!listed.stderr.includes('    at '), 'no stack trace for a malformed configuration')
})

test('a malformed catalog is reported rather than ignored', async () => {
  const { root } = await fixture()
  const broken = join(root, 'broken-manifest.json')
  writeFileSync(broken, `${JSON.stringify({
    schema: 1,
    patches: [
      { name: 'dupe', file: 'a.patch', summary: 'first' },
      { name: 'dupe', file: 'b.patch', summary: 'second' },
    ],
  })}\n`, 'utf8')
  const listed = run(['patch', 'list', '--manifest', broken], root)
  assert.equal(listed.status, 4)
  assert.match(listed.stderr, /duplicate patch name "dupe"/)
  assert.ok(!listed.stderr.includes('    at '), 'no stack trace for a bad catalog')

  const wrongSchema = join(root, 'schema-2.json')
  writeFileSync(wrongSchema, '{"schema":2,"patches":[]}\n', 'utf8')
  const rejected = run(['patch', 'list', '--manifest', wrongSchema], root)
  assert.equal(rejected.status, 4)
  assert.match(rejected.stderr, /unsupported "schema"/)
})

test('an unknown verb or a missing configuration is reported with the documented code', async () => {
  const { root } = await fixture()
  const unknown = run(['patch', 'frobnicate'], root)
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /unknown patch command "frobnicate"/)

  const uninitialized = mkdtempSync(join(tmpdir(), 'dsh-upgrade-patch-nocfg-'))
  const missing = run(['patch', 'list'], uninitialized)
  assert.equal(missing.status, 4)
  assert.match(missing.stderr, /run "dsh-upgrade init"/)
})
