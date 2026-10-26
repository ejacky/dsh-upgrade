/**
 * `check`: is there a newer upstream release tag?
 *
 * Fetches tags into the repository that backs the slots, picks the newest tag matching the
 * configured pattern, and compares it with what is deployed. Strictly newer only: a
 * re-tagged or older release is never proposed.
 *
 * @module dsh-upgrade/commands/check
 */
import { loadConfig, resolveConfigPath } from '../engine/config.ts'
import { readState, statePathOf, writeState } from '../engine/state.ts'
import { activeSlot, slotExists, slotPath, SLOT_NAMES } from '../engine/slots.ts'
import { fetchTags, listTags, tagAtHead } from '../engine/git.ts'
import { compareVersions, newestTag, parseTag } from '../engine/semver.ts'
import type { RunOptions } from '../cli.ts'

/** `check` flags. */
interface CheckFlags {
  readonly fetch: boolean
}

/**
 * Parse `check` arguments.
 * @param args - arguments after the command name.
 */
function parseFlags(args: readonly string[]): CheckFlags {
  let fetch = true
  for (const argument of args) {
    if (argument === '--no-fetch') { fetch = false; continue }
    throw new Error(`unknown argument "${argument}"`)
  }
  return { fetch }
}

/**
 * The repository the slots live in: the serving slot, else any existing slot.
 * @param config - resolved tool configuration.
 */
function repositoryOf(config: ReturnType<typeof loadConfig>): string | undefined {
  const active = activeSlot(config)
  if (active !== undefined && slotExists(config, active)) return slotPath(config, active)
  for (const name of SLOT_NAMES) {
    if (slotExists(config, name)) return slotPath(config, name)
  }
  return undefined
}

/**
 * Run `check`.
 * @param args - arguments after the command name.
 * @param options - global options.
 * @returns `0` when the check ran (a newer version may or may not exist), `4` when it could not.
 */
export function runCheck(args: readonly string[], options: RunOptions): number {
  let flags: CheckFlags
  try {
    flags = parseFlags(args)
  } catch (error) {
    process.stderr.write(`dsh-upgrade check: ${(error as Error).message}\n`)
    return 2
  }

  const configPath = resolveConfigPath(options.configPath, options.cwd, options.toolRoot)
  const config = loadConfig(configPath)
  const statePath = statePathOf(config)
  const state = readState(statePath)
  const now = new Date().toISOString()

  const repo = repositoryOf(config)
  if (repo === undefined) {
    const message = `no slot checkout under ${config.slotsRoot} (run "dsh-upgrade stage")`
    writeState(statePath, { ...state, lastCheck: now, lastError: message })
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: message, nextAction: 'stage' })}\n`)
    } else {
      process.stderr.write(`dsh-upgrade check: ${message}\n`)
    }
    return 4
  }

  const fetched = flags.fetch ? fetchTags(repo, config.upstream) : { ok: true, stdout: '', stderr: '' }
  const tags = listTags(repo, config.tagPattern)
  const active = activeSlot(config)
  const current = state.deployed?.tag ?? (active === undefined ? undefined : tagAtHead(slotPath(config, active)))
  const latest = newestTag(tags, config.tagPattern)
  const currentVersion = current === undefined ? undefined : parseTag(current, config.tagPattern)
  const newer = latest !== undefined && (currentVersion === undefined || compareVersions(latest, currentVersion) > 0)
  const fetchError = fetched.ok ? undefined : fetched.stderr.trim()

  writeState(statePath, {
    ...state,
    lastCheck: now,
    lastError: fetchError === undefined ? null : `fetch failed: ${fetchError}`,
  })

  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      ok: fetched.ok,
      current: current ?? null,
      latest: latest?.tag ?? null,
      newer: fetchError === undefined ? newer : false,
      candidate: fetchError === undefined && newer ? latest?.tag ?? null : null,
      tags,
      ...fetchError === undefined ? {} : { error: fetchError },
    })}\n`)
  } else if (fetchError !== undefined) {
    process.stderr.write(`dsh-upgrade check: could not fetch ${config.upstream}\n  ${fetchError}\n`)
    process.stdout.write(`  local newest ${latest?.tag ?? '(none)'}  current ${current ?? '(none)'}\n`)
  } else {
    const verdict = latest === undefined
      ? 'no matching tag'
      : current === undefined
        ? 'no deployed version yet'
        : newer ? 'newer version available' : 'already current'
    process.stdout.write([
      `dsh-upgrade check`,
      `  upstream  ${config.upstream}`,
      `  current   ${current ?? '(none)'}`,
      `  newest    ${latest?.tag ?? '(none)'}`,
      `  verdict   ${verdict}`,
      ...(newer && latest !== undefined ? [`  next      dsh-upgrade stage`] : []),
    ].join('\n') + '\n')
  }
  return fetched.ok ? 0 : 4
}

