/**
 * `doctor` reports probes and turns the protection-driver result into configuration.
 * @module dsh-upgrade/tests/doctor
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IS_WINDOWS, skipUnlessPosix, skipUnlessWindows } from './helpers/platform.ts'

const repoRoot = join(import.meta.dirname, '..')
const cliPath = join(repoRoot, 'src', 'cli.ts')

/** Run the CLI in a directory. */
function run(args: readonly string[], cwd: string, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

test('doctor reports the toolchain and the stable-path state as JSON', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-doctor-'))
  writeFileSync(join(root, 'dsh-upgrade.json'), `${JSON.stringify({ schema: 1, root, webPort: 39871, smokePort: 39872 }, null, 2)}\n`, 'utf8')
  const result = run(['doctor', '--json'], root)
  const report = JSON.parse(result.stdout) as { ok: boolean, probes: { id: string, ok: boolean }[] }
  const ids = report.probes.map(probe => probe.id)
  // The probe list is a platform contract: PowerShell and the protection driver exist on
  // Windows, the systemd user session exists elsewhere. Neither reports the other's absence.
  const expected = process.platform === 'win32'
    ? ['powershell-7', 'node-24', 'git', 'pnpm', 'stable-path', 'protection-driver', 'disk']
    : ['node-24', 'git', 'pnpm', 'systemd-user', 'stable-path', 'disk']
  for (const id of expected) {
    assert.ok(ids.includes(id), `missing probe ${id}`)
  }
  // The probe list is a platform contract: a probe that cannot mean anything here must not be
  // reported at all, not reported as passing.
  if (IS_WINDOWS) {
    assert.equal(ids.includes('systemd-user'), false, 'Windows has no systemd user session')
  } else {
    for (const id of ['powershell-7', 'protection-driver', 'long-paths']) {
      assert.equal(ids.includes(id), false, `${id} is a Windows-only probe`)
    }
  }
  assert.equal(report.probes.find(probe => probe.id === 'node-24')?.ok, true)
  assert.equal(result.status === 0 || result.status === 4, true)
})

test('doctor --fix sets manualBuild when the protection driver refuses the delete', (context) => {
  if (skipUnlessWindows(context, 'the protection-driver probe exists only on Windows')) return
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

test('doctor --fix says there is nothing to fix on a platform without the probe', (context) => {
  if (skipUnlessPosix(context)) return
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-doctor-nofix-'))
  writeFileSync(join(root, 'dsh-upgrade.json'), `${JSON.stringify({ schema: 1, root, webPort: 39879, smokePort: 39880 }, null, 2)}\n`, 'utf8')
  const fixed = run(['doctor', '--fix', '--json'], root)
  const report = JSON.parse(fixed.stdout) as { fixed: string[] }
  assert.deepEqual(report.fixed, [], 'nothing can be repaired when the probe does not exist')
})

test('doctor reports a missing configuration as blocking', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-upgrade-doctor-nocfg-'))
  const result = run(['doctor', '--json', '--config', join(dir, 'absent.json')], dir)
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

test('doctor reports whether the installed harness sends the gateway header', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-doctor-header-'))
  const stable = join(root, 'deepseek-harness')
  writeFileSync(join(root, 'dsh-upgrade.json'), `${JSON.stringify({ schema: 1, root, webPort: 39877, smokePort: 39878 }, null, 2)}\n`, 'utf8')

  const probeOf = (): { ok: boolean, detail: string, nextAction?: string } => {
    const result = run(['doctor', '--json'], root)
    const report = JSON.parse(result.stdout) as {
      blocking: string[]
      probes: { id: string, ok: boolean, detail: string, nextAction?: string }[]
    }
    const probe = report.probes.find(candidate => candidate.id === 'provider-session-header')
    assert.notEqual(probe, undefined, 'doctor must probe the provider header')
    assert.equal(report.blocking.includes('provider-session-header'), false, 'a stale build is a warning, not a blocker')
    return probe as { ok: boolean, detail: string, nextAction?: string }
  }

  // Nothing built yet: a fresh machine must not be told the header is missing.
  const before = probeOf()
  assert.equal(before.ok, true)
  assert.match(before.detail, /no built harness/)

  // The workspace link the harness actually loads.
  const providerDir = join(stable, 'packages', 'llm', 'llm-pi-ai', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers')
  mkdirSync(providerDir, { recursive: true })
  writeFileSync(join(providerDir, 'opencode-headers.js'), 'const OPENCODE_SESSION_HEADER = "x-opencode-session";\n', 'utf8')
  const native = probeOf()
  assert.equal(native.ok, true)
  assert.match(native.detail, /natively/)

  // An older build: the file exists but adds nothing, and the fix is a newer release.
  writeFileSync(join(providerDir, 'opencode-headers.js'), 'export const nothing = true;\n', 'utf8')
  const old = probeOf()
  assert.equal(old.ok, false)
  assert.match(old.nextAction ?? '', /newer harness/)

  // A layout with neither a link nor a pnpm store cannot be read, and must say so rather than
  // claim pi-ai is missing.
  rmSync(join(stable, 'packages'), { recursive: true, force: true })
  mkdirSync(join(stable, 'node_modules'), { recursive: true })
  const unknown = probeOf()
  assert.equal(unknown.ok, false)
  assert.match(unknown.detail, /cannot read the package store/)
})
