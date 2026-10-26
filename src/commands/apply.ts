/**
 * `apply` / `rollback`: switch which slot serves, with automatic rollback.
 *
 * The switch stops the server, so it can never run inside the process it replaces: the
 * foreground command validates, takes the lock, spawns a detached worker, and returns. The
 * worker stops the server, flips the junction, starts the new slot, waits for it, and flips
 * back when it does not answer.
 *
 * @module dsh-upgrade/commands/apply
 */
import { spawn } from 'node:child_process'
import { existsSync, openSync, closeSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, resolveConfigPath } from '../engine/config.ts'
import { describeLink, setLink } from '../engine/link.ts'
import { acquireLock } from '../engine/lock.ts'
import { startService, stopService, waitForService } from '../engine/service.ts'
import { activeSlot, slotExists, slotPath, spareSlot, type SlotName } from '../engine/slots.ts'
import { readState, statePathOf, writeState, withDeployed, type SlotRecord } from '../engine/state.ts'
import { tagAtHead } from '../engine/git.ts'
import type { RunOptions } from '../cli.ts'

/** `apply` flags. */
interface ApplyFlags {
  readonly wait: boolean
  readonly execute: boolean
  readonly slot?: SlotName
  readonly tag?: string
  readonly noStart: boolean
}

/**
 * Parse `apply` arguments.
 * @param args - arguments after the command name.
 */
function parseFlags(args: readonly string[]): ApplyFlags {
  let wait = false
  let execute = false
  let slot: SlotName | undefined
  let tag: string | undefined
  let noStart = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--wait') { wait = true; continue }
    if (argument === '--execute') { execute = true; continue }
    if (argument === '--no-start') { noStart = true; continue }
    if (argument === '--slot' || argument === '--tag') {
      const value = args[index + 1]
      if (value === undefined) throw new Error(`${argument} needs a value`)
      if (argument === '--slot') {
        if (value !== 'a' && value !== 'b') throw new Error('--slot must be a or b')
        slot = value
      } else {
        tag = value
      }
      index += 1
      continue
    }
    throw new Error(`unknown argument "${argument}"`)
  }
  return { wait, execute, ...slot === undefined ? {} : { slot }, ...tag === undefined ? {} : { tag }, noStart }
}

/** The outcome of one switch attempt. */
interface SwitchOutcome {
  readonly ok: boolean
  readonly slot: SlotName
  readonly tag: string
  readonly error?: string
}

/**
 * Perform one switch, rolling back when the new slot does not answer.
 * @param config - resolved tool configuration.
 * @param target - slot to serve.
 * @param tag - tag expected in that slot.
 * @param noStart - flip without starting a server (tests, or a stopped machine).
 */
async function switchTo(
  config: Parameters<typeof waitForService>[0],
  target: SlotName,
  tag: string,
  noStart: boolean,
): Promise<SwitchOutcome> {
  const previous = activeSlot(config)
  const previousTag = previous === undefined ? undefined : tagAtHead(slotPath(config, previous))
  const directory = slotPath(config, target)
  try {
    setLink(config.stablePath, directory)
  } catch (error) {
    return { ok: false, slot: target, tag, error: (error as Error).message }
  }
  stopService(config.webPort)
  if (noStart) return { ok: true, slot: target, tag }

  let started
  try {
    started = startService(config, directory)
  } catch (error) {
    // The old server is already stopped: restore the previous slot *and* start it again,
    // otherwise a failed switch would leave the machine serving nothing.
    if (previous !== undefined) {
      setLink(config.stablePath, slotPath(config, previous))
      try {
        const restarted = startService(config, slotPath(config, previous))
        await waitForService(config, restarted.logPath)
      } catch {
        // Reported below; the operator can start the old version by hand.
      }
    }
    return { ok: false, slot: target, tag, error: (error as Error).message }
  }
  const ready = await waitForService(config, started.logPath)
  if (ready) return { ok: true, slot: target, tag }

  // Roll back: the previous slot becomes the stable path again and is restarted.
  stopService(config.webPort)
  if (previous !== undefined) {
    setLink(config.stablePath, slotPath(config, previous))
    try {
      const restarted = startService(config, slotPath(config, previous))
      await waitForService(config, restarted.logPath)
    } catch {
      // Leaving the old slot in place is still better than serving nothing new; the caller
      // reports the failure and the operator can start it by hand.
    }
  }
  return {
    ok: false,
    slot: target,
    tag,
    error: `new version did not answer on ${config.webPort}${previous === undefined ? '' : `; rolled back to slot ${previous}${previousTag === undefined ? '' : ` (${previousTag})`}`}`,
  }
}

/**
 * Worker body: switch and record the result. Runs in the detached process.
 * @param config - resolved tool configuration.
 * @param target - slot to serve.
 * @param tag - tag to record.
 * @param noStart - skip starting a server.
 * @returns the process exit code.
 */
async function executeSwitch(config: Parameters<typeof waitForService>[0], target: SlotName, tag: string, noStart: boolean): Promise<number> {
  const statePath = statePathOf(config)
  const outcome = await switchTo(config, target, tag, noStart)
  const state = readState(statePath)
  if (!outcome.ok) {
    writeState(statePath, { ...state, lastError: outcome.error ?? 'switch failed' })
    process.stderr.write(`dsh-upgrade apply: ${outcome.error ?? 'switch failed'}\n`)
    return 4
  }
  // Keep the client metadata `stage` recorded: `status` reports the serving build's frontend.
  const buildRecord = join(slotPath(config, target), '.dsh-build', 'client-build-environment.json')
  let client: { clientVersion?: string, clientArtifacts?: number } = {}
  if (existsSync(buildRecord)) {
    try {
      const parsed = JSON.parse(readFileSync(buildRecord, 'utf8')) as { environment?: { DSH_CLIENT_VERSION?: unknown }, artifacts?: { fileCount?: unknown } }
      const version = parsed.environment?.DSH_CLIENT_VERSION
      const count = parsed.artifacts?.fileCount
      if (typeof version === 'string') client = { ...client, clientVersion: version }
      if (typeof count === 'number') client = { ...client, clientArtifacts: count }
    } catch {
      // A malformed record only costs the display fields.
    }
  }
  const record: SlotRecord = { tag, slot: target, at: new Date().toISOString(), ...client }
  writeState(statePath, withDeployed(state, record))
  process.stdout.write(`serving ${tag} from slot ${target}\n`)
  return 0
}

/**
 * Run `apply`.
 * @param args - arguments after the command name.
 * @param options - global options.
 * @returns the process exit code.
 */
export async function runApply(args: readonly string[], options: RunOptions): Promise<number> {
  let flags: ApplyFlags
  try {
    flags = parseFlags(args)
  } catch (error) {
    process.stderr.write(`dsh-upgrade apply: ${(error as Error).message}\n`)
    return 2
  }
  const configPath = resolveConfigPath(options.configPath, options.cwd, options.toolRoot)
  if (!existsSync(configPath)) {
    process.stderr.write(`dsh-upgrade apply: ${configPath} not found (run "dsh-upgrade init")\n`)
    return 4
  }
  const config = loadConfig(configPath)

  if (flags.execute) {
    if (flags.slot === undefined || flags.tag === undefined) return 2
    // The worker mutates the layout, so it holds the same lock as `stage`.
    const workerLock = acquireLock(join(config.root, 'state', 'layout.lock'))
    if (workerLock === undefined) {
      process.stderr.write('dsh-upgrade apply: another layout action is running\n')
      return 3
    }
    try {
      return await executeSwitch(config, flags.slot, flags.tag, flags.noStart)
    } finally {
      workerLock.release()
    }
  }

  const state = readState(statePathOf(config))
  const staged = state.staged
  if (staged === null) {
    process.stderr.write('dsh-upgrade apply: nothing staged (run "dsh-upgrade stage")\n')
    return 3
  }
  const link = describeLink(config.stablePath)
  if (link.kind === 'directory') {
    process.stderr.write(`dsh-upgrade apply: ${config.stablePath} is a real directory; refusing to replace it\n`)
    return 3
  }
  if (!slotExists(config, staged.slot)) return 4

  if (!flags.wait) {
    // Detached: the switch stops the server, so it must outlive this invocation.
    const fd = openSync(join(config.root, 'logs', `apply-${staged.tag}.log`), 'a')
    try {
      const child = spawn(process.execPath, [
        import.meta.filename, 'apply', '--execute', '--slot', staged.slot, '--tag', staged.tag,
        ...flags.noStart ? ['--no-start'] : [],
        ...options.configPath === undefined ? [] : ['--config', options.configPath],
      ], { cwd: options.cwd, stdio: ['ignore', fd, fd], detached: true, windowsHide: true })
      child.unref()
    } finally {
      closeSync(fd)
    }
    process.stdout.write(`switching to ${staged.tag} in the background; watch ${join(config.root, 'logs')}\n`)
    return 0
  }

  const lock = acquireLock(join(config.root, 'state', 'layout.lock'))
  if (lock === undefined) {
    process.stderr.write('dsh-upgrade apply: another switch is running\n')
    return 3
  }
  try {
    return await executeSwitch(config, staged.slot, staged.tag, flags.noStart)
  } finally {
    lock.release()
  }
}

/**
 * Run `rollback`: serve the slot that is not currently serving.
 * @param args - arguments after the command name.
 * @param options - global options.
 * @returns the process exit code.
 */
export async function runRollback(args: readonly string[], options: RunOptions): Promise<number> {
  let noStart = false
  for (const argument of args) {
    if (argument === '--no-start') { noStart = true; continue }
    process.stderr.write(`dsh-upgrade rollback: unknown argument "${argument}"\n`)
    return 2
  }
  const configPath = resolveConfigPath(options.configPath, options.cwd, options.toolRoot)
  if (!existsSync(configPath)) {
    process.stderr.write(`dsh-upgrade rollback: ${configPath} not found (run "dsh-upgrade init")
`)
    return 4
  }
  const config = loadConfig(configPath)
  const target = spareSlot(config)
  if (!slotExists(config, target)) {
    process.stderr.write(`dsh-upgrade rollback: slot ${target} has no checkout\n`)
    return 4
  }
  const tag = tagAtHead(slotPath(config, target))
  if (tag === undefined) {
    process.stderr.write(`dsh-upgrade rollback: slot ${target} is not at a tag\n`)
    return 4
  }
  return executeSwitch(config, target, tag, noStart)
}




