/**
 * The green zip: what it contains, and that it runs once unpacked.
 *
 * The archive is the product. These tests check the two ways it can be wrong without anyone
 * noticing: a missing directory (the plugin, the tray script, the patch catalog) and a
 * `setup.cmd` that cmd.exe cannot read.
 *
 * @module dsh-upgrade/tests/package
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..')
const packager = join(repoRoot, 'scripts', 'package.mjs')

/** Run the packager and parse its JSON summary. */
function pack(args: readonly string[]): { status: number, report: Record<string, unknown>, stderr: string } {
  const result = spawnSync(process.execPath, [packager, ...args], { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`)
  const last = result.stdout.trim().split(/\r?\n/).at(-1) ?? ''
  const report = last.startsWith('{') ? JSON.parse(last) as Record<string, unknown> : {}
  return { status: result.status ?? -1, report, stderr: result.stderr }
}

test('the zip would carry every runtime directory and nothing else', () => {
  const dry = pack(['--dry-run'])
  assert.equal(dry.status, 0, dry.stderr)
  const contents = dry.report['contents'] as string[]
  assert.ok(Array.isArray(contents))
  for (const required of [
    'src/cli.ts',
    'engine-ps/tray.ps1',
    'patches/manifest.json',
    'plugins/opencode-session/lib/index.js',
    'plugins/opencode-session/cordis.patch.yml',
    'plugins/opencode-session/LICENSE',
    'plugins/opencode-session/NOTICE.md',
    'setup.cmd',
    'package.json',
    'version.json',
  ]) {
    assert.ok(contents.includes(required), `the zip must carry ${required}`)
  }
  for (const excluded of contents.filter(path => /^(tests|node_modules|dist)\//.test(path) || path.startsWith('.github/'))) {
    assert.fail(`the zip must not carry ${excluded}`)
  }
})

test('the zip builds and unpacks into a tool that runs', () => {
  const out = mkdtempSync(join(tmpdir(), 'dsh-upgrade-zip-'))
  const built = pack(['--out', out])
  assert.equal(built.status, 0, built.stderr)
  const zip = built.report['zip'] as string
  assert.ok(existsSync(zip), `expected ${zip}`)
  assert.ok(statSync(zip).size > 20_000, 'the archive should not be a stub')

  const unpacked = join(out, 'unpacked')
  const expanded = spawnSync('pwsh', ['-NoProfile', '-Command', `Expand-Archive -Path '${zip}' -DestinationPath '${unpacked}' -Force`], { encoding: 'utf8' })
  assert.equal(expanded.status, 0, expanded.stderr)
  assert.ok(existsSync(join(unpacked, '.dsh-upgrade-release')), 'an unpacked release marks itself')

  const version = spawnSync(process.execPath, [join(unpacked, 'src', 'cli.ts'), '--version'], { encoding: 'utf8' })
  assert.equal(version.status, 0, version.stderr)
  assert.match(version.stdout, /^dsh-upgrade \d+\.\d+\.\d+/)
  const help = spawnSync(process.execPath, [join(unpacked, 'src', 'cli.ts'), '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /opencode-session/)
  assert.equal(readdirSync(unpacked).includes('tests'), false)
})

test('setup.cmd is pure ASCII and installs the bundled plugin', () => {
  const path = join(repoRoot, 'setup.cmd')
  const bytes = readFileSync(path)
  const nonAscii = bytes.filter(byte => byte > 127)
  assert.equal(nonAscii.length, 0, 'cmd.exe reads this file in the console code page')
  const text = bytes.toString('latin1')
  assert.match(text, /set "CLI=!HERE!\\src\\cli\.ts"/i)
  assert.match(text, /node "!CLI!"/i)
  assert.match(text, /opencode-session install/)
  assert.match(text, /shortcuts --install/)
  assert.match(text, /process\.versions\.node/)
})

test('the release workflow publishes the zip and its checksum', () => {
  const text = readFileSync(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8')
  assert.match(text, /windows-latest/)
  assert.match(text, /npm run typecheck/)
  assert.match(text, /npm test/)
  assert.match(text, /node scripts\/package\.mjs/)
  assert.match(text, /dist\/\*\.zip/)
  assert.match(text, /SHA256SUMS\.txt/)
})
