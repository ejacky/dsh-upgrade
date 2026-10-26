/**
 * `tray`: the companion is resolvable, and the script itself is valid PowerShell.
 *
 * The tray cannot be driven from a test — it owns a message loop and a notification area icon
 * — so what is pinned here is what a broken installation gets wrong: the command line the
 * companion is started with, and whether the shipped script even parses.
 *
 * @module dsh-upgrade/tests/tray
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..')
const cliPath = join(repoRoot, 'src', 'cli.ts')

/** Run the CLI and capture its streams and exit code. */
function run(args: readonly string[], cwd: string = repoRoot): { status: number, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8' })
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`)
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

/** Whether PowerShell 7 is available on this machine. */
function hasPwsh(): boolean {
  const probe = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' })
  return probe.status === 0 && Number.parseInt((probe.stdout ?? '').trim(), 10) >= 7
}

test('tray --dry-run prints the command the companion would run', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-upgrade-tray-dry-'))
  const configPath = join(home, 'dsh-upgrade.json')
  writeFileSync(configPath, `${JSON.stringify({ schema: 1, root: home }, null, 2)}\n`, 'utf8')
  const dry = run(['tray', '--dry-run', '--json', '--config', configPath])
  assert.equal(dry.status, 0, dry.stderr)
  const report = JSON.parse(dry.stdout) as { ok: boolean, script: string, cli: string, config: string, args: string[] }
  assert.equal(report.ok, true)
  assert.equal(report.script, join(repoRoot, 'engine-ps', 'tray.ps1'))
  assert.equal(existsSync(report.script), true)
  assert.equal(report.cli, join(repoRoot, 'src', 'cli.ts'))
  assert.equal(report.config, configPath)
  assert.deepEqual(report.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'])
  assert.equal(report.args[5], report.script)
  for (const flag of ['-ToolRoot', '-Cli', '-Config', '-Node']) {
    assert.ok(report.args.includes(flag), `the companion must receive ${flag}`)
  }
})

test('tray rejects arguments it does not have', () => {
  const rejected = run(['tray', '--now'])
  assert.equal(rejected.status, 2)
  assert.match(rejected.stderr, /unknown argument "--now"/)
})

test('tray without a configuration asks for init instead of starting', () => {
  const empty = mkdtempSync(join(tmpdir(), 'dsh-upgrade-tray-nocfg-'))
  const missing = run(['tray'], empty)
  assert.equal(missing.status, 4)
  assert.match(missing.stderr, /run "dsh-upgrade init"/)
})

test('tray reports a configuration it cannot read', () => {
  const broken = mkdtempSync(join(tmpdir(), 'dsh-upgrade-tray-broken-'))
  writeFileSync(join(broken, 'dsh-upgrade.json'), '{"schema":1,"root":""}\n', 'utf8')
  const reported = run(['tray'], broken)
  assert.equal(reported.status, 4)
  assert.match(reported.stderr, /must be a non-empty string/)
  assert.ok(!reported.stderr.includes('    at '), 'no stack trace for a bad configuration')
})

test('the companion script parses as PowerShell', (context) => {
  if (!hasPwsh()) {
    context.skip('pwsh 7 is not installed')
    return
  }
  const script = join(repoRoot, 'engine-ps', 'tray.ps1')
  const command = [
    '$tokens = $null; $errors = $null',
    `[System.Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors) | Out-Null`,
    'if ($errors.Count -gt 0) { $errors | ForEach-Object { "line $($_.Extent.StartLineNumber): $($_.Message)" }; exit 1 }',
    "'ok'",
  ].join('\n')
  const parsed = spawnSync('pwsh', ['-NoProfile', '-Command', command], { encoding: 'utf8' })
  assert.equal(parsed.status, 0, `${parsed.stdout}${parsed.stderr}`)
  assert.equal(parsed.stdout.trim(), 'ok')
})
