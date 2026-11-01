#!/usr/bin/env node
/**
 * Build the green archive: everything the tool needs to run from an unpacked folder.
 *
 * The archive carries TypeScript sources, because Node 24 runs them directly; it carries no
 * `node_modules`, no test files, and no build output, so unpacking is the whole install.
 *
 * Windows produces the zip with PowerShell's `Compress-Archive`, which is present on every
 * machine this tool supports. Elsewhere the product is a `.tar.gz` made by `tar`, which is the
 * same "unpack and run" promise without asking a Linux machine to install PowerShell.
 *
 * @module dsh-upgrade/scripts/package
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const toolRoot = join(import.meta.dirname, '..')

/** The machine this release is for. */
const PLATFORM = process.platform === 'win32' ? 'win32' : 'linux'
const IS_WINDOWS = PLATFORM === 'win32'

/** Archive extension: a zip on Windows, a tarball elsewhere. */
const ARCHIVE_EXTENSION = IS_WINDOWS ? 'zip' : 'tar.gz'

/** Directories shipped whole, in the order they appear in the archive. */
const DIRECTORIES = ['src', ...IS_WINDOWS ? ['engine-ps'] : [], 'patches', 'docs']

/** Files shipped at the archive root. The installer is the one platform-specific file. */
const FILES = [
  ...IS_WINDOWS ? ['setup.cmd'] : ['setup.sh'],
  'README.md',
  'LICENSE',
  'package.json',
  'version.json',
]

/** Files the archive cannot work without. */
const REQUIRED = [
  'src/cli.ts',
  'patches/manifest.json',
  ...IS_WINDOWS ? ['engine-ps/tray.ps1', 'setup.cmd'] : ['setup.sh'],
]

/**
 * Every file the archive contains, relative to the tool root.
 * @param root - the tool's own directory.
 * @returns sorted relative paths.
 */
function filesOf(root) {
  const files = []
  for (const directory of DIRECTORIES) {
    const absolute = join(root, directory)
    if (!existsSync(absolute)) continue
    for (const entry of readdirSync(absolute, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const path = join(entry.parentPath ?? entry.path, entry.name)
      files.push(relative(root, path).replaceAll('\\', '/'))
    }
  }
  for (const file of FILES) {
    if (existsSync(join(root, file))) files.push(file)
  }
  return files.sort()
}

/**
 * Read the tool version.
 * @param root - the tool's own directory.
 */
function versionOf(root) {
  const parsed = JSON.parse(readFileSync(join(root, 'version.json'), 'utf8'))
  if (typeof parsed.name !== 'string' || typeof parsed.version !== 'string') {
    throw new Error('version.json needs "name" and "version"')
  }
  return { name: parsed.name, version: parsed.version }
}

/**
 * Print a failure and exit.
 * @param message - what went wrong.
 */
function fail(message) {
  process.stderr.write(`package: ${message}\n`)
  process.exit(1)
}

const argumentsList = process.argv.slice(2)
const dryRun = argumentsList.includes('--dry-run')
const outIndex = argumentsList.indexOf('--out')
const outDirectory = outIndex === -1 ? join(toolRoot, 'dist') : argumentsList[outIndex + 1]
if (outDirectory === undefined) fail('--out needs a directory')

const { name, version } = versionOf(toolRoot)
const files = filesOf(toolRoot)
if (files.length === 0) fail('no files to package')
for (const required of REQUIRED) {
  if (!files.includes(required)) fail(`the archive would be unusable: ${required} is missing`)
}

const archive = join(outDirectory, `${name}-${version}.${ARCHIVE_EXTENSION}`)
const bytes = files.reduce((total, file) => total + statSync(join(toolRoot, file)).size, 0)
const summary = {
  ok: true,
  name,
  version,
  platform: PLATFORM,
  files: files.length,
  bytes,
  archive,
  // `zip` predates the tarball channel; keep it on Windows so existing scripts keep working.
  ...(IS_WINDOWS ? { zip: archive } : {}),
}

if (dryRun) {
  process.stdout.write(`${JSON.stringify({ ...summary, contents: files, dryRun: true })}\n`)
  process.exit(0)
}

const staging = join(outDirectory, `staging-${version}`)
rmSync(staging, { recursive: true, force: true })
try {
  for (const file of files) {
    const target = join(staging, ...file.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(toolRoot, ...file.split('/')), target)
  }
  // A marker so an unpacked folder can tell it is a release rather than a working tree.
  writeFileSync(join(staging, '.dsh-upgrade-release'), `${version}\n`, 'utf8')
} catch (error) {
  rmSync(staging, { recursive: true, force: true })
  fail(`could not stage the archive: ${error.message}`)
}
mkdirSync(outDirectory, { recursive: true })
rmSync(archive, { force: true })

if (IS_WINDOWS) {
  // Single quotes are the one character PowerShell cannot take literally inside a single-quoted
  // string; double them so a path like `C:\O'Brien` still packs.
  const psQuote = value => `'${value.replaceAll("'", "''")}'`
  const packed = spawnSync('pwsh', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Compress-Archive -Path ${psQuote(join(staging, '*'))} -DestinationPath ${psQuote(archive)} -CompressionLevel Optimal`,
  ], { encoding: 'utf8' })
  if (packed.status !== 0) {
    rmSync(staging, { recursive: true, force: true })
    fail(`Compress-Archive failed: ${packed.error?.message ?? ((packed.stderr ?? '').trim() || 'no output')}`)
  }
} else {
  // `-C staging .` keeps the archive's contents at its root, which is what `setup.sh` expects.
  const packed = spawnSync('tar', ['-czf', archive, '-C', staging, '.'], { encoding: 'utf8' })
  if (packed.status !== 0) {
    rmSync(staging, { recursive: true, force: true })
    fail(`tar failed: ${packed.error?.message ?? ((packed.stderr ?? '').trim() || 'no output')}`)
  }
}
rmSync(staging, { recursive: true, force: true })

process.stdout.write(`${JSON.stringify({ ...summary, bytes: statSync(archive).size })}\n`)
