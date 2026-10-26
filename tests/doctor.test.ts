/**
 * `doctor` reports probes and turns the protection-driver result into configuration.
 * @module dsh-upgrade/tests/doctor
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..')
const cliPath = join(repoRoot, 'src', 'cli.ts')

/** Run the CLI in a directory. */
function run(args: readonly string[], cwd: string, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

test('doctor reports the toolchain and the stable-path state as JSON', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-doctor-'))
  writeFileSync(join(root, 'dsh-upgrade.json'), `${JSON.stringify({ schema: 1, root, webPort: 39871, smokePort: 39872 }, null, 2)}\n`, 'utf8')
  const result = run(['doctor', '--json'], root)
  const report = JSON.parse(result.stdout) as { ok: boolean, probes: { id: string, ok: boolean }[] }
  const ids = report.probes.map(probe => probe.id)
  for (const id of ['powershell-7', 'node-24', 'git', 'pnpm', 'stable-path', 'protection-driver', 'disk']) {
    assert.ok(ids.includes(id), `missing probe ${id}`)
  }
  assert.equal(report.probes.find(probe => probe.id === 'node-24')?.ok, true)
  assert.equal(result.status === 0 || result.status === 4, true)
})

test('doctor --fix sets manualBuild when the protection driver refuses the delete', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-doctor-fix-'))
  writeFileSync(join(root, 'dsh-upgrade.json'), `${JSON.stringify({ schema: 1, root, webPort: 39873, smokePort: 39874 }, null, 2)}\n`, 'utf8')
  const before = run(['doctor', '--json'], root)
  const report = JSON.parse(before.stdout) as { probes: { id: string, ok: boolean }[] }
  const protection = report.probes.find(probe => probe.id === 'protection-driver')
  if (protection?.ok === true) return // the machine allows the delete; nothing to repair
  assert.equal(run(['doctor', '--fix'], root).status >= 0, true)
  const config = JSON.parse(readFileSync(join(root, 'dsh-upgrade.json'), 'utf8')) as { manualBuild: boolean }
  assert.equal(config.manualBuild, true)
})

test('doctor reports a missing configuration as blocking', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-upgrade-doctor-nocfg-'))
  const result = run(['doctor', '--json'], dir)
  assert.equal(result.status, 4)
  const report = JSON.parse(result.stdout) as { ok: boolean, blocking: string[] }
  assert.equal(report.ok, false)
  assert.ok(report.blocking.includes('config'))
})

test('doctor --fix keeps keys this build does not know', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-doctor-keep-'))
  writeFileSync(join(root, 'dsh-upgrade.json'), `${JSON.stringify({ schema: 1, root, webPort: 39875, smokePort: 39876, future: 1 }, null, 2)}\n`, 'utf8')
  run(['doctor', '--fix'], root)
  const config = JSON.parse(readFileSync(join(root, 'dsh-upgrade.json'), 'utf8')) as { future?: number, manualBuild?: boolean }
  assert.equal(config.future, 1)
})

test('doctor names which mechanism provides the gateway session header', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-doctor-session-'))
  const home = join(root, 'dsh-home')
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(root, 'dsh-upgrade.json'), `${JSON.stringify({ schema: 1, root, webPort: 39877, smokePort: 39878 }, null, 2)}\n`, 'utf8')

  const probeOf = (): { ok: boolean, detail: string } => {
    const result = run(['doctor', '--json'], root, { DSH_HOME: home })
    const report = JSON.parse(result.stdout) as { probes: { id: string, ok: boolean, detail: string }[] }
    const probe = report.probes.find(candidate => candidate.id === 'opencode-session')
    assert.notEqual(probe, undefined, 'doctor must probe the session header')
    return probe as { ok: boolean, detail: string }
  }

  // Nothing installed: the header is missing.
  writeFileSync(join(profile, 'package.json'), '{"name":"dsh-profile-web","private":true}\n', 'utf8')
  const missing = probeOf()
  assert.equal(missing.ok, false)
  assert.match(missing.detail, /not installed in profile web/)

  // The old mechanism: a provider sessionHeader.
  writeFileSync(join(profile, 'cordis.patch.yml'), '- id: llm-pi-ai\n  config:\n    providers:\n      opencode-go:\n        sessionHeader: x-opencode-session\n', 'utf8')
  const legacy = probeOf()
  assert.equal(legacy.ok, true)
  assert.match(legacy.detail, /does not survive an upstream change/)

  // The plugin, with the legacy line gone.
  writeFileSync(join(profile, 'cordis.patch.yml'), '- id: llm-pi-ai\n  config: {}\n', 'utf8')
  writeFileSync(join(profile, 'package.json'), '{"name":"dsh-profile-web","private":true,"dependencies":{"dsh-x-opencode-session":"0.1.1"}}\n', 'utf8')
  const plugin = probeOf()
  assert.equal(plugin.ok, true)
  assert.match(plugin.detail, /^0\.1\.1 in profile web/)
})
