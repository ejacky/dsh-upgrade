/**
 * Reading the DSH profile this tool manages.
 *
 * The profile is DSH's own state, not ours: `dsh plugin add` writes it, the harness loads it.
 * `opencode-session` and `doctor` both need to know what it says, so the reading lives here
 * and stays read-only — writing the profile is the DSH CLI's job, except for the patch layer
 * entries this tool owns.
 *
 * @module dsh-upgrade/engine/profile
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Config } from './config.ts'

/** Package name the gateway header comes from. */
export const SESSION_PACKAGE = 'dsh-x-opencode-session'

/**
 * The DSH home, resolved the way the harness resolves it: `$DSH_HOME`, then `~/.dsh`.
 * @returns the absolute home directory.
 */
export function dshHome(): string {
  const configured = process.env['DSH_HOME']
  const selected = configured !== undefined && configured.trim() !== '' ? configured.trim() : join(homedir(), '.dsh')
  return resolve(selected.startsWith('~') ? join(homedir(), selected.slice(1)) : selected)
}

/**
 * Directory of the profile this tool manages.
 * @param config - resolved tool configuration.
 */
export function profileDirOf(config: Config): string {
  return join(dshHome(), 'profiles', config.profile)
}

/** What the profile currently says. */
export interface ProfileState {
  /** Whether the profile directory exists. */
  readonly exists: boolean
  /** Version recorded as a dependency, when installed. */
  readonly version?: string
  /** Whether the profile lists the package as a bundle layer. */
  readonly bundle: boolean
  /** The user patch layer's text, when present. */
  readonly patch?: string
  /** Lines that still set a provider `sessionHeader`. */
  readonly sessionHeader: readonly string[]
  /** Whether the settings override this tool writes is present. */
  readonly override: boolean
}

/**
 * Read the profile's manifest and patch layer. Never writes.
 * @param directory - profile directory.
 * @returns what the profile says, with an absent profile reported as `exists: false`.
 */
export function profileStateOf(directory: string): ProfileState {
  const manifestPath = join(directory, 'package.json')
  const patchPath = join(directory, 'cordis.patch.yml')
  const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : undefined
  const shared = {
    ...patch === undefined ? {} : { patch },
    sessionHeader: patch === undefined ? [] : sessionHeaderLines(patch),
    override: patch !== undefined && patch.includes(OVERRIDE_MARKER),
  }
  if (!existsSync(manifestPath)) return { exists: false, bundle: false, ...shared }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  const version = manifest.dependencies?.[SESSION_PACKAGE]
  return {
    exists: true,
    ...version === undefined ? {} : { version },
    bundle: manifest.dsh?.profile?.bundles?.includes(SESSION_PACKAGE) === true,
    ...shared,
  }
}

/** Marker comment above the settings override this tool owns. */
export const OVERRIDE_MARKER = '# dsh-upgrade: x-opencode-session settings (written by "dsh-upgrade opencode-session install")'

/**
 * Lines of a profile patch that set a provider `sessionHeader`.
 * @param patch - the patch file's text.
 */
export function sessionHeaderLines(patch: string): string[] {
  return patch.split(/\r?\n/).filter(line => /^\s+sessionHeader:\s*\S/.test(line))
}
