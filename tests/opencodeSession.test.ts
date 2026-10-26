/**
 * `opencode-session`: installing the bundled plugin into a DSH profile.
 *
 * The DSH CLI is replaced by a stand-in that edits the profile the way `dsh plugin add` does,
 * so the whole sequence runs offline: pack the vendored plugin, install it, verify the
 * profile, drop the legacy provider header, and write the settings override.
 *
 * @module dsh-upgrade/tests/opencodeSession
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..')
const cliPath = join(repoRoot, 'src', 'cli.ts')

/**
 * The stand-in DSH CLI: `plugin --profile <name> add|remove <spec>` edits the profile
 * manifest the way the real command does, including the bundle list.
 */
const FAKE_DSH_CLI = `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
const at = args.indexOf('--profile')
if (at === -1) { console.error('fake dsh: missing --profile'); process.exit(2) }
const profile = args[at + 1]
const [verb, spec] = args.slice(at + 2)
const dir = join(process.env.DSH_HOME ?? '', 'profiles', profile)
mkdirSync(dir, { recursive: true })
const manifestPath = join(dir, 'package.json')
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : { name: 'dsh-profile-' + profile, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }
manifest.dependencies ??= {}
manifest.dsh ??= { profile: { bundles: [] } }
manifest.dsh.profile ??= { bundles: [] }
const name = 'dsh-x-opencode-session'
if (verb === 'add') {
  manifest.dependencies[name] = '0.1.1'
  if (!manifest.dsh.profile.bundles.includes(name)) manifest.dsh.profile.bundles.push(name)
} else if (verb === 'remove') {
  delete manifest.dependencies[name]
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(bundle => bundle !== name)
} else {
  console.error('fake dsh: unsupported ' + String(verb))
  process.exit(2)
}
writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\\n')
console.log('fake dsh: ' + verb + ' ' + String(spec))
`

/** A layout with a stable path, a stand-in DSH CLI, and a DSH home. */
interface Fixture {
  readonly root: string
  readonly home: string
  readonly profileDir: string
  readonly env: Record<string, string>
}

/**
 * Build the layout.
 * @param options - `header`/`urlMarkers`/`source` for the tool configuration.
 */
function fixture(options: { header?: string, urlMarkers?: string[], source?: string, enabled?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-oc-'))
  const home = join(root, 'dsh-home')
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2)}\n`, 'utf8')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), [
    '# profile patch',
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      opencode-go:',
    '        apiKeyEnv: OPENCODE_GO_API_KEY',
    '        sessionHeader: x-opencode-session',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    provider: opencode-go',
    '',
  ].join('\n'), 'utf8')

  const dshCli = join(root, 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js')
  mkdirSync(join(dshCli, '..'), { recursive: true })
  writeFileSync(dshCli, FAKE_DSH_CLI, 'utf8')

  writeFileSync(join(root, 'dsh-upgrade.json'), `${JSON.stringify({
    schema: 1,
    root,
    profile: 'web',
    opencodeSession: {
      enabled: options.enabled ?? true,
      source: options.source ?? 'builtin',
      header: options.header ?? 'x-opencode-session',
      urlMarkers: options.urlMarkers ?? ['opencode.ai'],
    },
  }, null, 2)}\n`, 'utf8')

  return { root, home, profileDir, env: { DSH_HOME: home } }
}

/** Run the CLI with the fixture's DSH home. */
function run(args: readonly string[], fixture: Fixture): { status: number, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, ...fixture.env },
  })
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`)
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

/** Read the fixture's profile manifest. */
function manifestOf(fixture: Fixture): { dependencies: Record<string, string>, dsh: { profile: { bundles: string[] } } } {
  return JSON.parse(readFileSync(join(fixture.profileDir, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
    dsh: { profile: { bundles: string[] } }
  }
}

/** Read the fixture's patch layer. */
function patchOf(fixture: Fixture): string {
  return readFileSync(join(fixture.profileDir, 'cordis.patch.yml'), 'utf8')
}

test('status reports a profile without the plugin', () => {
  const layout = fixture()
  const status = run(['opencode-session', 'status', '--json'], layout)
  assert.equal(status.status, 0, status.stderr)
  const report = JSON.parse(status.stdout) as {
    ok: boolean, installed: boolean, bundle: boolean, override: boolean, sessionHeader: boolean, cli: { available: boolean }
  }
  assert.equal(report.ok, true)
  assert.equal(report.installed, false)
  assert.equal(report.bundle, false)
  assert.equal(report.override, false)
  assert.equal(report.sessionHeader, true)
  assert.equal(report.cli.available, true)
})

test('install adds the plugin, drops the legacy header, and writes the override', () => {
  const layout = fixture({ header: 'x-custom-session', urlMarkers: ['gateway.example'] })
  const installed = run(['opencode-session', 'install', '--json'], layout)
  assert.equal(installed.status, 0, installed.stderr)
  const report = JSON.parse(installed.stdout) as {
    ok: boolean, installed: string, bundle: boolean, sessionHeaderRemoved: number, overrideWritten: boolean, kind: string
  }
  assert.equal(report.ok, true)
  assert.equal(report.installed, '0.1.1')
  assert.equal(report.bundle, true)
  assert.equal(report.sessionHeaderRemoved, 1)
  assert.equal(report.overrideWritten, true)

  const manifest = manifestOf(layout)
  assert.equal(manifest.dependencies['dsh-x-opencode-session'], '0.1.1')
  assert.ok(manifest.dsh.profile.bundles.includes('dsh-x-opencode-session'), 'dsh plugin add records the layer')

  const patch = patchOf(layout)
  assert.doesNotMatch(patch, /sessionHeader/)
  assert.match(patch, /# dsh-upgrade: x-opencode-session settings/)
  assert.match(patch, /header: x-custom-session/)
  assert.match(patch, /- gateway\.example/)
  assert.match(patch, /- id: agent-default-model/, 'the rest of the patch survives')
  const backups = readdirSync(layout.profileDir).filter(name => name.startsWith('cordis.patch.yml.bak-'))
  assert.equal(backups.length, 1, 'the original patch is kept next to the new one')
})

test('install with the default settings writes no override', () => {
  const layout = fixture()
  const installed = run(['opencode-session', 'install', '--json'], layout)
  assert.equal(installed.status, 0, installed.stderr)
  const report = JSON.parse(installed.stdout) as { overrideWritten: boolean }
  assert.equal(report.overrideWritten, false)
  assert.doesNotMatch(patchOf(layout), /# dsh-upgrade: x-opencode-session settings/)
})

test('install is idempotent and replaces a stale override instead of stacking them', () => {
  const layout = fixture({ header: 'x-first' })
  assert.equal(run(['opencode-session', 'install', '--json'], layout).status, 0)
  writeFileSync(join(layout.root, 'dsh-upgrade.json'), `${JSON.stringify({
    schema: 1,
    root: layout.root,
    profile: 'web',
    opencodeSession: { header: 'x-second', urlMarkers: ['opencode.ai'] },
  }, null, 2)}\n`, 'utf8')
  const again = run(['opencode-session', 'install', '--json'], layout)
  assert.equal(again.status, 0, again.stderr)
  const patch = patchOf(layout)
  assert.equal(patch.match(/# dsh-upgrade: x-opencode-session settings/g)?.length, 1)
  assert.match(patch, /header: x-second/)
  assert.doesNotMatch(patch, /x-first/)
})

test('install --dry-run changes nothing', () => {
  const layout = fixture({ header: 'x-dry' })
  const before = patchOf(layout)
  const dry = run(['opencode-session', 'install', '--dry-run', '--json'], layout)
  assert.equal(dry.status, 0, dry.stderr)
  const report = JSON.parse(dry.stdout) as { dryRun: boolean, sessionHeader: number, differs: boolean }
  assert.equal(report.dryRun, true)
  assert.equal(report.sessionHeader, 1)
  assert.equal(report.differs, true)
  assert.equal(patchOf(layout), before)
  assert.deepEqual(manifestOf(layout).dependencies, {})
})

test('install respects enabled=false and source=off', () => {
  const disabled = fixture({ enabled: false })
  const refused = run(['opencode-session', 'install'], disabled)
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /enabled is false/)

  const off = fixture({ source: 'off' })
  const noSource = run(['opencode-session', 'install'], off)
  assert.equal(noSource.status, 2)
  assert.match(noSource.stderr, /source is "off"/)
})

test('install from npm names the published package', () => {
  const layout = fixture({ source: 'npm' })
  const installed = run(['opencode-session', 'install', '--json'], layout)
  assert.equal(installed.status, 0, installed.stderr)
  const report = JSON.parse(installed.stdout) as { kind: string, spec: string, source: string }
  assert.equal(report.source, 'npm')
  assert.equal(report.kind, 'npm')
  assert.equal(report.spec, 'dsh-x-opencode-session@0.1.1')
})

test('remove drops the dependency and the override', () => {
  const layout = fixture({ header: 'x-remove' })
  assert.equal(run(['opencode-session', 'install', '--json'], layout).status, 0)
  assert.match(patchOf(layout), /x-remove/)

  const removed = run(['opencode-session', 'remove', '--json'], layout)
  assert.equal(removed.status, 0, removed.stderr)
  const report = JSON.parse(removed.stdout) as { removed: boolean, overrideRemoved: boolean, restartRequired: boolean }
  assert.equal(report.overrideRemoved, true)
  assert.equal(report.restartRequired, true)
  assert.deepEqual(manifestOf(layout).dependencies, {})
  assert.doesNotMatch(patchOf(layout), /# dsh-upgrade: x-opencode-session settings/)
})

test('install without a usable DSH CLI asks for a stage first', () => {
  const layout = fixture()
  // Remove the stand-in CLI: the stable path then has no built harness.
  const cli = join(layout.root, 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js')
  spawnSync('cmd', ['/c', 'del', '/q', cli], { encoding: 'utf8' })
  assert.equal(existsSync(cli), false)
  const refused = run(['opencode-session', 'install', '--json'], layout)
  assert.equal(refused.status, 3)
  const report = JSON.parse(refused.stdout) as { ok: boolean, error: string, nextAction: string }
  assert.equal(report.ok, false)
  assert.match(report.error, /DSH CLI was not found/)
  assert.equal(report.nextAction, 'human')
})
