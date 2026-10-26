/**
 * `opencode-session`: install the bundled x-opencode-session support.
 *
 * DeepSeek Harness has no configuration seam for a per-provider request header, so the
 * gateway header comes from a plugin. The plugin is vendored (`plugins/opencode-session`) and
 * installed into the DSH profile through `dsh plugin add`, which also records it as a profile
 * layer so its `cordis.patch.yml` row is loaded.
 *
 * Two settings can exist twice, and this command owns both:
 * - a provider's `sessionHeader` in the profile patch did the same job by patching the source.
 *   It is removed, because two mechanisms sending one header is a bug waiting to happen.
 * - a non-default header or URL marker is written as an id-targeted override, which applies
 *   after the plugin's own layer.
 *
 * @module dsh-upgrade/commands/opencodeSession
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RunOptions } from '../cli.ts'
import { loadConfig, resolveConfigPath, type Config } from '../engine/config.ts'
import { OVERRIDE_MARKER, profileDirOf, profileStateOf, SESSION_PACKAGE } from '../engine/profile.ts'

/** Exit codes; see `src/cli.ts` for the contract. */
const EXIT = { ok: 0, usage: 2, manual: 3, probe: 4 } as const

/** Package name the profile records. */
const PACKAGE_NAME = SESSION_PACKAGE

/** Row id the profile patch targets. */
const ROW_ID = 'x-opencode-session'

/** Defaults the vendored plugin ships with. */
const DEFAULT_HEADER = 'x-opencode-session'
const DEFAULT_MARKERS: readonly string[] = ['opencode.ai']

/** Verbs this command accepts. */
const VERBS = ['install', 'remove', 'status'] as const

/** A `opencode-session` verb. */
type Verb = typeof VERBS[number]

/** Parsed arguments. */
interface SessionFlags {
  /** Which verb to run; `status` when none was given. */
  readonly verb: Verb
  /** `--dry-run`: report what would change, write nothing. */
  readonly dryRun: boolean
}

/**
 * Parse arguments.
 * @param args - arguments after the command name.
 */
function parseFlags(args: readonly string[]): SessionFlags {
  let verb: Verb | undefined
  let dryRun = false
  for (const argument of args) {
    if (argument === '--dry-run') { dryRun = true; continue }
    if (argument.startsWith('-')) throw new Error(`unknown argument "${argument}"`)
    if (verb !== undefined) throw new Error(`unexpected argument "${argument}"`)
    if (!VERBS.includes(argument as Verb)) throw new Error(`unknown opencode-session command "${argument}" (expected ${VERBS.join(', ')})`)
    verb = argument as Verb
  }
  return { verb: verb ?? 'status', dryRun }
}

/**
 * Remove provider `sessionHeader` entries from a patch, leaving everything else alone.
 * @param patch - the patch file's text.
 * @returns the stripped text and how many lines went away.
 */
function withoutSessionHeader(patch: string): { text: string, removed: number } {
  const lines = patch.split(/\r?\n/)
  const kept = lines.filter(line => !/^\s+sessionHeader:\s*\S/.test(line))
  return { text: kept.join('\n'), removed: lines.length - kept.length }
}

/**
 * Render the settings override block.
 * @param header - header name.
 * @param markers - URL markers.
 */
function overrideBlock(header: string, markers: readonly string[]): string {
  return [
    OVERRIDE_MARKER,
    `- id: ${ROW_ID}`,
    '  config:',
    `    header: ${header}`,
    ...markers.length === 0 ? [] : ['    urlMarkers:', ...markers.map(marker => `      - ${marker}`)],
    '',
  ].join('\n')
}

/**
 * Line range of the settings override: the marker line plus the single top-level entry under
 * it. Reading lines instead of matching text keeps a stale block from being half-replaced.
 * @param lines - the patch file split on newlines.
 * @param markerIndex - index of the marker line.
 * @returns the half-open range `[start, end)`.
 */
function overrideRange(lines: readonly string[], markerIndex: number): { start: number, end: number } {
  let end = markerIndex + 1
  let seenEntry = false
  while (end < lines.length) {
    const line = lines[end] ?? ''
    if (line.startsWith('- ')) {
      if (seenEntry) break
      seenEntry = true
    } else if (seenEntry && line !== '' && !line.startsWith(' ') && !line.startsWith('#')) {
      break
    }
    end += 1
  }
  return { start: markerIndex, end }
}

/**
 * Insert or replace the settings override block.
 * @param patch - the patch file's text.
 * @param header - header name.
 * @param markers - URL markers.
 * @returns the new text.
 */
function withOverride(patch: string, header: string, markers: readonly string[]): string {
  const block = overrideBlock(header, markers).replace(/\n$/, '').split('\n')
  const lines = patch.split(/\r?\n/)
  const markerIndex = lines.findIndex(line => line.trim() === OVERRIDE_MARKER)
  if (markerIndex === -1) {
    const body = patch.endsWith('\n') ? lines.slice(0, -1) : lines
    return `${[...body, ...block].join('\n')}\n`
  }
  const { start, end } = overrideRange(lines, markerIndex)
  return `${[...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n')}\n`
}

/**
 * Drop the settings override block.
 * @param patch - the patch file's text.
 * @returns the new text and whether anything was removed.
 */
function withoutOverride(patch: string): { text: string, removed: boolean } {
  const lines = patch.split(/\r?\n/)
  const markerIndex = lines.findIndex(line => line.trim() === OVERRIDE_MARKER)
  if (markerIndex === -1) return { text: patch, removed: false }
  const { start, end } = overrideRange(lines, markerIndex)
  return { text: `${[...lines.slice(0, start), ...lines.slice(end)].join('\n')}\n`, removed: true }
}

/**
 * The DSH CLI that owns the profile, taken from whatever the stable path serves.
 * @param config - resolved tool configuration.
 */
function dshCliOf(config: Config): string | undefined {
  const candidate = join(config.stablePath, 'apps', 'cli', 'lib', 'bin.js')
  return existsSync(candidate) ? candidate : undefined
}

/**
 * Run one `dsh plugin` command in the profile.
 * @param cli - DSH CLI entry.
 * @param profile - profile name.
 * @param args - arguments after `--profile <name>`.
 * @param timeoutMs - upper bound.
 */
function runDshPlugin(
  cli: string,
  profile: string,
  args: readonly string[],
  timeoutMs = 10 * 60 * 1000,
): { code: number, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, [cli, 'plugin', '--profile', profile, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  })
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: (result.stderr ?? '') + (result.error === undefined ? '' : result.error.message),
  }
}

/**
 * Pack the vendored plugin into a tarball the profile can install from.
 *
 * A tarball is copied into the profile, so moving or deleting the tool later cannot break the
 * installation. When npm cannot be found, the plugin directory itself is used instead: pnpm
 * links it, which works but ties the profile to this path.
 * @param pluginDir - the vendored package.
 * @param destination - where the tarball goes.
 * @returns the spec to install, and how it was produced.
 */
function packPlugin(pluginDir: string, destination: string): { spec: string, kind: 'tarball' | 'directory', error?: string } {
  mkdirSync(destination, { recursive: true })
  const npmCli = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find(candidate => existsSync(candidate))
  const args = ['pack', pluginDir, '--pack-destination', destination, '--json']
  const packed = npmCli === undefined
    ? spawnSync('npm', args, { encoding: 'utf8', shell: true, timeout: 120_000 })
    : spawnSync(process.execPath, [npmCli, ...args], { encoding: 'utf8', timeout: 120_000 })
  if (packed.status !== 0) {
    return {
      spec: pluginDir,
      kind: 'directory',
      error: `${(packed.stderr ?? '').trim() || 'npm pack failed'}; installing the directory instead`,
    }
  }
  try {
    const report = JSON.parse(packed.stdout) as { filename?: unknown }[]
    const filename = report[0]?.filename
    if (typeof filename === 'string' && existsSync(join(destination, filename))) {
      return { spec: join(destination, filename), kind: 'tarball' }
    }
  } catch {
    // Fall through to the directory form.
  }
  return { spec: pluginDir, kind: 'directory', error: 'npm pack printed no file name; installing the directory instead' }
}

/**
 * Print a failure on the channel the caller reads.
 * @param message - what went wrong.
 * @param code - exit code.
 * @param json - whether `--json` output was requested.
 */
function reportFailure(message: string, code: number, json: boolean): number {
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message, nextAction: code === EXIT.manual ? 'human' : 'retry' })}\n`)
  else process.stderr.write(`dsh-upgrade opencode-session: ${message}\n`)
  return code
}

/**
 * Run `opencode-session`.
 * @param args - arguments after the command name.
 * @param options - global options.
 * @returns the process exit code.
 */
export function runOpencodeSession(args: readonly string[], options: RunOptions): number {
  let flags: SessionFlags
  try {
    flags = parseFlags(args)
  } catch (error) {
    process.stderr.write(`dsh-upgrade opencode-session: ${(error as Error).message}\n`)
    return EXIT.usage
  }

  try {
    const configPath = resolveConfigPath(options.configPath, options.cwd, options.toolRoot)
    if (!existsSync(configPath)) return reportFailure(`${configPath} not found (run "dsh-upgrade init")`, EXIT.probe, options.json)
    const config = loadConfig(configPath)
    const directory = profileDirOf(config)
    const state = profileStateOf(directory)
    const header = config.opencodeSession.header
    const markers = config.opencodeSession.urlMarkers
    const differs = header !== DEFAULT_HEADER || markers.join(',') !== DEFAULT_MARKERS.join(',')
    const cli = dshCliOf(config)
    const progress = (line: string): void => { if (!options.json) process.stderr.write(`${line}\n`) }

    if (flags.verb === 'status') {
      if (options.json) {
        process.stdout.write(`${JSON.stringify({
          ok: true,
          profile: config.profile,
          directory,
          installed: state.version !== undefined,
          version: state.version ?? null,
          bundle: state.bundle,
          override: state.override,
          sessionHeader: state.sessionHeader.length > 0,
          expected: { header, urlMarkers: markers },
          cli: { available: cli !== undefined, path: cli ?? null },
        })}\n`)
        return EXIT.ok
      }
      process.stdout.write([
        'dsh-upgrade opencode-session status',
        `  profile    ${config.profile} (${directory})`,
        `  installed  ${state.version === undefined ? 'no' : `${state.version}${state.bundle ? '' : ' (not a profile layer)'}`}`,
        `  settings   ${state.override ? `${header} on ${markers.join(', ')}` : `defaults (${DEFAULT_HEADER} on ${DEFAULT_MARKERS.join(', ')})`}`,
        `  legacy     ${state.sessionHeader.length > 0 ? 'providers still set sessionHeader; run "install" to remove it' : 'no provider sessionHeader'}`,
        `  dsh CLI    ${cli ?? 'not found under the stable path (run "stage" and "apply" first)'}`,
      ].join('\n') + '\n')
      return EXIT.ok
    }

    if (flags.verb === 'remove') {
      if (cli === undefined) return reportFailure('the DSH CLI was not found under the stable path; run "stage" and "apply" first', EXIT.manual, options.json)
      if (flags.dryRun) {
        if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, action: 'remove', profile: config.profile, installed: state.version !== undefined })}\n`)
        else process.stdout.write(`would run: dsh plugin --profile ${config.profile} remove ${PACKAGE_NAME}\n`)
        return EXIT.ok
      }
      progress(`removing ${PACKAGE_NAME} from profile ${config.profile}`)
      const removed = runDshPlugin(cli, config.profile, ['remove', PACKAGE_NAME])
      if (removed.code !== 0) return reportFailure(`dsh plugin remove failed: ${(removed.stderr || removed.stdout).trim()}`, EXIT.probe, options.json)
      let overrideRemoved = false
      const patchPath = join(directory, 'cordis.patch.yml')
      if (existsSync(patchPath)) {
        const { text, removed: stripped } = withoutOverride(readFileSync(patchPath, 'utf8'))
        if (stripped) {
          writeFileSync(patchPath, text, 'utf8')
          overrideRemoved = true
        }
      }
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, action: 'remove', overrideRemoved, restartRequired: true })}\n`)
        return EXIT.ok
      }
      process.stdout.write([
        `removed ${PACKAGE_NAME} from profile ${config.profile}`,
        '  restart the web service for the change to take effect',
        state.sessionHeader.length > 0
          ? '  note: no provider sessionHeader is left behind; restore one in the profile patch if the gateway needs it again'
          : '',
      ].filter(line => line !== '').join('\n') + '\n')
      return EXIT.ok
    }

    // install
    if (!config.opencodeSession.enabled) {
      return reportFailure('opencodeSession.enabled is false in the configuration; the bundled support is off by design', EXIT.usage, options.json)
    }
    if (cli === undefined) {
      return reportFailure('the DSH CLI was not found under the stable path; run "stage" and "apply" first', EXIT.manual, options.json)
    }
    const pluginDir = join(options.toolRoot, 'plugins', 'opencode-session')
    if (!existsSync(join(pluginDir, 'lib', 'index.js'))) {
      return reportFailure(`the bundled plugin is missing at ${pluginDir}; reinstall the tool`, EXIT.probe, options.json)
    }
    const source = config.opencodeSession.source
    if (source === 'off') return reportFailure('opencodeSession.source is "off"; nothing to install', EXIT.usage, options.json)

    let spec: string
    let kind: 'tarball' | 'directory' | 'npm' = 'npm'
    const notes: string[] = []
    if (source === 'builtin') {
      const packed = packPlugin(pluginDir, join(config.root, 'state', 'plugins'))
      spec = packed.spec
      kind = packed.kind
      if (packed.error !== undefined) notes.push(packed.error)
    } else {
      spec = `${PACKAGE_NAME}@${pluginVersionOf(pluginDir) ?? 'latest'}`
    }

    if (flags.dryRun) {
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, action: 'install', profile: config.profile, spec, kind, differs, sessionHeader: state.sessionHeader.length })}\n`)
        return EXIT.ok
      }
      process.stdout.write([
        `would run: dsh plugin --profile ${config.profile} add ${spec}`,
        state.sessionHeader.length === 0 ? '' : `would remove ${state.sessionHeader.length} provider sessionHeader line(s)`,
        differs ? `would write the ${header} / ${markers.join(', ')} settings override` : '',
      ].filter(line => line !== '').join('\n') + '\n')
      return EXIT.ok
    }

    progress(`installing ${spec} into profile ${config.profile}`)
    const added = runDshPlugin(cli, config.profile, ['add', spec])
    if (added.code !== 0) {
      return reportFailure(
        `dsh plugin add failed: ${(added.stderr || added.stdout).trim()}`
        + (kind === 'directory' ? '\nThe plugin was linked as a directory; moving the tool later breaks the profile.' : ''),
        EXIT.probe,
        options.json,
      )
    }

    const patchPath = join(directory, 'cordis.patch.yml')
    let sessionHeaderRemoved = 0
    let overrideWritten = false
    const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : undefined
    if (patch !== undefined) {
      let next = patch
      const stripped = withoutSessionHeader(next)
      next = stripped.text
      sessionHeaderRemoved = stripped.removed
      if (differs) {
        next = withOverride(next, header, markers)
        overrideWritten = true
      } else if (next.includes(OVERRIDE_MARKER)) {
        // The operator went back to the defaults; the stale override would contradict them.
        const cleared = withoutOverride(next)
        next = cleared.text
        overrideWritten = cleared.removed
      }
      if (next !== patch) {
        // Keep one backup per install so a hand-edited patch is never lost.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        renameSync(patchPath, `${patchPath}.bak-${stamp}`)
        writeFileSync(patchPath, next, 'utf8')
      }
    }

    const after = profileStateOf(directory)
    const ok = after.version !== undefined
    if (options.json) {
      process.stdout.write(`${JSON.stringify({
        ok,
        action: 'install',
        profile: config.profile,
        source,
        spec,
        kind,
        installed: after.version ?? null,
        bundle: after.bundle,
        sessionHeaderRemoved,
        overrideWritten,
        restartRequired: ok,
        notes,
      })}\n`)
      return ok ? EXIT.ok : EXIT.probe
    }
    process.stdout.write([
      ok
        ? `installed ${PACKAGE_NAME}@${after.version ?? '?'} into profile ${config.profile}${after.bundle ? '' : ' (not recorded as a profile layer!)'}`
        : `dsh plugin add reported success, but the profile does not list ${PACKAGE_NAME}`,
      sessionHeaderRemoved === 0 ? '' : `  removed ${sessionHeaderRemoved} provider sessionHeader line(s)`,
      overrideWritten ? `  settings override: ${header} on ${markers.join(', ')}` : '',
      ...notes.map(note => `  ! ${note}`),
      '  restart the web service for the change to take effect',
    ].filter(line => line !== '').join('\n') + '\n')
    return ok ? EXIT.ok : EXIT.probe
  } catch (error) {
    return reportFailure((error as Error).message, EXIT.probe, options.json)
  }
}

/**
 * Read the vendored plugin's version.
 * @param pluginDir - the vendored package.
 */
function pluginVersionOf(pluginDir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}
