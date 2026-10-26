#!/usr/bin/env node
/**
 * Build the green zip: everything the tool needs to run from an unpacked folder.
 *
 * The zip carries TypeScript sources, because Node 24 runs them directly; it carries no
 * `node_modules`, no test files, and no build output, so unpacking it is the whole install.
 * The archive is produced with PowerShell's `Compress-Archive`, which is present on every
 * machine this tool supports and avoids a dependency only a release job would use.
 *
 * @module dsh-upgrade/scripts/package
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const toolRoot = join(import.meta.dirname, '..')

/** Directories shipped whole, in the order they appear in the archive. */
const DIRECTORIES = ['src', 'engine-ps', 'patches', 'plugins', 'templates', 'docs']

/** Files shipped at the archive root. */
const FILES = ['setup.cmd', 'README.md', 'LICENSE', 'package.json', 'version.json']

/**
 * Every file the zip contains, relative to the tool root.
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
for (const required of ['src/cli.ts', 'setup.cmd', 'plugins/opencode-session/lib/index.js', 'patches/manifest.json']) {
  if (!files.includes(required)) fail(`the zip would be unusable: ${required} is missing`)
}

const bytes = files.reduce((total, file) => total + statSync(join(toolRoot, file)).size, 0)
const summary = {
  ok: true,
  name,
  version,
  files: files.length,
  bytes,
  zip: join(outDirectory, `${name}-${version}.zip`),
}

if (dryRun) {
  process.stdout.write(`${JSON.stringify({ ...summary, contents: files, dryRun: true })}\n`)
  process.exit(0)
}

const staging = join(outDirectory, `staging-${version}`)
rmSync(staging, { recursive: true, force: true })
for (const file of files) {
  const target = join(staging, ...file.split('/'))
  mkdirSync(dirname(target), { recursive: true })
  cpSync(join(toolRoot, ...file.split('/')), target)
}
// A marker so an unpacked folder can tell it is a release rather than a working tree.
writeFileSync(join(staging, '.dsh-upgrade-release'), `${version}\n`, 'utf8')
mkdirSync(outDirectory, { recursive: true })
rmSync(summary.zip, { force: true })

const packed = spawnSync('pwsh', [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  `Compress-Archive -Path '${join(staging, '*')}' -DestinationPath '${summary.zip}' -CompressionLevel Optimal`,
], { encoding: 'utf8' })
if (packed.status !== 0) {
  rmSync(staging, { recursive: true, force: true })
  fail(`Compress-Archive failed: ${(packed.stderr ?? '').trim() || 'no output'}`)
}
rmSync(staging, { recursive: true, force: true })

process.stdout.write(`${JSON.stringify({ ...summary, bytes: statSync(summary.zip).size })}\n`)
