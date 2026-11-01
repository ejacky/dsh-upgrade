/**
 * The green archive: what it contains, and that it runs once unpacked.
 *
 * The archive is the product. These tests check the two ways it can be wrong without anyone
 * noticing: a missing directory (the tray script, the patch catalog) and an installer the
 * platform's shell cannot read.
 *
 * @module dsh-upgrade/tests/package
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IS_WINDOWS, skipUnlessPosix, skipUnlessWindows, unpack } from './helpers/platform.ts'

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

test('the archive would carry every runtime directory and nothing else', () => {
  const dry = pack(['--dry-run'])
  assert.equal(dry.status, 0, dry.stderr)
  const contents = dry.report['contents'] as string[]
  assert.ok(Array.isArray(contents))
  const required = IS_WINDOWS
    ? [
      'src/cli.ts',
      'engine-ps/tray.ps1',
      'patches/manifest.json',
      'setup.cmd',
      'package.json',
      'version.json',
    ]
    : [
      'src/cli.ts',
      'patches/manifest.json',
      'setup.sh',
      'package.json',
      'version.json',
    ]
  for (const item of required) {
    assert.ok(contents.includes(item), `the archive must carry ${item}`)
  }
  assert.equal(dry.report['platform'], IS_WINDOWS ? 'win32' : 'linux')
  assert.equal(contents.includes('setup.cmd'), IS_WINDOWS, 'the Windows installer is Windows-only')
  assert.equal(contents.includes('setup.sh'), !IS_WINDOWS, 'the POSIX installer is POSIX-only')
  assert.equal(contents.includes('engine-ps/tray.ps1'), IS_WINDOWS, 'the tray script ships where it can run')
  assert.equal(contents.some(path => path.startsWith('plugins/')), false, 'the retired plugin is not shipped')
  for (const excluded of contents.filter(path => /^(tests|node_modules|dist)\//.test(path) || path.startsWith('.github/'))) {
    assert.fail(`the archive must not carry ${excluded}`)
  }
})

test('the archive builds and unpacks into a tool that runs', () => {
  const out = mkdtempSync(join(tmpdir(), 'dsh-upgrade-archive-'))
  const built = pack(['--out', out])
  assert.equal(built.status, 0, built.stderr)
  const archive = (built.report['archive'] ?? built.report['zip']) as string
  assert.ok(existsSync(archive), `expected ${archive}`)
  assert.ok(statSync(archive).size > 20_000, 'the archive should not be a stub')

  const unpacked = join(out, 'unpacked')
  unpack(archive, unpacked)
  assert.ok(existsSync(join(unpacked, '.dsh-upgrade-release')), 'an unpacked release marks itself')

  const version = spawnSync(process.execPath, [join(unpacked, 'src', 'cli.ts'), '--version'], { encoding: 'utf8' })
  assert.equal(version.status, 0, version.stderr)
  assert.match(version.stdout, /^dsh-upgrade \d+\.\d+\.\d+/)
  const help = spawnSync(process.execPath, [join(unpacked, 'src', 'cli.ts'), '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /doctor/)
  assert.equal(readdirSync(unpacked).includes('tests'), false)
})

test('the Windows installer is pure ASCII and creates the launchers', (context) => {
  if (skipUnlessWindows(context, 'setup.cmd is the Windows installer')) return
  const path = join(repoRoot, 'setup.cmd')
  const bytes = readFileSync(path)
  const nonAscii = bytes.filter(byte => byte > 127)
  assert.equal(nonAscii.length, 0, 'cmd.exe reads this file in the console code page')
  const text = bytes.toString('latin1')
  assert.match(text, /set "CLI=!HERE!\\src\\cli\.ts"/i)
  assert.match(text, /node "!CLI!"/i)
  assert.match(text, /shortcuts --install/)
  assert.doesNotMatch(text, /opencode-session/)
  assert.match(text, /process\.versions\.node/)
})

test('the POSIX installer is pure ASCII and creates the launchers', (context) => {
  if (skipUnlessPosix(context, 'setup.sh is the POSIX installer')) return
  const bytes = readFileSync(join(repoRoot, 'setup.sh'))
  const nonAscii = bytes.filter(byte => byte > 127)
  assert.equal(nonAscii.length, 0, '/bin/sh may run in a minimal locale')
  const text = bytes.toString('utf8')
  assert.match(text, /^#!\/bin\/sh/)
  assert.match(text, /node "\$CLI" --config "\$CONFIG" doctor/)
  assert.match(text, /shortcuts --install/)
  assert.doesNotMatch(text, /opencode-session/)
  assert.match(text, /process\.versions\.node/)
  assert.match(text, /set -eu/)
})

test('the release workflow publishes both platforms and their checksums', () => {
  const text = readFileSync(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8')
  assert.match(text, /windows-latest/)
  assert.match(text, /ubuntu-latest/)
  assert.match(text, /npm run typecheck/)
  assert.match(text, /npm test/)
  assert.match(text, /node scripts\/package\.mjs/)
  assert.match(text, /dist\/\*\.zip/)
  assert.match(text, /dist\/\*\.tar\.gz/)
  assert.match(text, /SHA256SUMS\.txt/)
  assert.match(text, /SHA256SUMS-linux\.txt/)
})
