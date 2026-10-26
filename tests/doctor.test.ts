/**
 * `doctor` reports probes and turns the protection-driver result into configuration.
 * @module dsh-upgrade/tests/doctor
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
