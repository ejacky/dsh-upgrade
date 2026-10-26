/**
 * `stage`: prepare the spare slot and prove it starts.
 *
 * The serving slot is never written. Every step either finishes with a smoke-tested slot and
 * a `staged` record, or fails with a message and no record — a half-prepared slot is never
 * announced as ready.
 *
 * @module dsh-upgrade/commands/stage
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { loadConfig, resolveConfigPath, type Config } from '../engine/config.ts'
import { describeLink } from '../engine/link.ts'
import { portOwner } from '../engine/service.ts'
import { fetchTags, listTags, lsRemoteTags, tagsAtHead } from '../engine/git.ts'
import { acquireLock } from '../engine/lock.ts'
import { applyPatches } from '../engine/patches.ts'
import { build, install } from '../engine/pnpm.ts'
import { compareVersions, globMatches, newestTag, parseTag } from '../engine/semver.ts'
import { smoke } from '../engine/smoke.ts'
import { activeSlot, slotExists, slotPath, spareSlot, type SlotName } from '../engine/slots.ts'
import { readState, statePathOf, writeState, type SlotRecord } from '../engine/state.ts'
import { ensureCheckout, isPrepared } from '../engine/worktree.ts'
import type { RunOptions } from '../cli.ts'

/** `stage` flags. */
interface StageFlags {
  readonly tag?: string
  readonly skipBuild: boolean
  readonly skipInstall: boolean
  readonly force: boolean
  readonly fetch: boolean
  /** Finish a slot whose build ran in an administrator console. */
  readonly resume: boolean
}

/**
 * Parse `stage` arguments.
 * @param args - arguments after the command name.
 */
function parseFlags(args: readonly string[]): StageFlags {
  let tag: string | undefined
  let skipBuild = false
  let skipInstall = false
  let force = false
  let fetch = true
  let resume = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--skip-build') { skipBuild = true; continue }
    if (argument === '--skip-install') { skipInstall = true; continue }
    if (argument === '--force') { force = true; continue }
    if (argument === '--no-fetch') { fetch = false; continue }
    if (argument === '--resume') { resume = true; continue }
    if (argument === '--tag') {
      const value = args[index + 1]
      if (value === undefined) throw new Error('--tag needs a value')
      tag = value
      index += 1
      continue
    }
    throw new Error(`unknown argument "${argument}"`)
  }
  return { ...tag === undefined ? {} : { tag }, skipBuild, skipInstall, force, fetch, resume }
}

/** Client metadata read from a slot's build record. */
interface ClientRecord {
  readonly clientVersion?: string
  readonly clientArtifacts?: number
}

/**
 * Read a slot's client build record.
 * @param slotDirectory - the slot.
 * @returns the recorded client version and artifact count when present.
 */
function clientRecordOf(slotDirectory: string): ClientRecord {
  const path = join(slotDirectory, '.dsh-build', 'client-build-environment.json')
  if (!existsSync(path)) return {}
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      environment?: { DSH_CLIENT_VERSION?: unknown }
      artifacts?: { fileCount?: unknown }
    }
    const version = raw.environment?.DSH_CLIENT_VERSION
    const count = raw.artifacts?.fileCount
    return {
      ...typeof version === 'string' ? { clientVersion: version } : {},
      ...typeof count === 'number' ? { clientArtifacts: count } : {},
    }
  } catch {
    return {}
  }
}

/** File the manual-build path leaves behind for `stage --resume`. */
export const BUILD_REQUEST_FILENAME = 'build-request.json'

/** What `stage` asked an administrator console to build. */
interface BuildRequest {
  readonly tag: string
  readonly slot: SlotName
}

/**
 * Read the pending build request.
 * @param config - resolved tool configuration.
 * @returns the request, or `undefined` when none is pending or the file is unusable.
 */
function readBuildRequest(config: Config): BuildRequest | undefined {
  const path = join(config.root, 'state', BUILD_REQUEST_FILENAME)
  if (!existsSync(path)) return undefined
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { tag?: unknown, slot?: unknown }
  if (typeof raw.tag !== 'string' || (raw.slot !== 'a' && raw.slot !== 'b')) return undefined
  return { tag: raw.tag, slot: raw.slot }
}

/**
 * Finish a slot whose build ran in an administrator console.
 *
 * The manual-build machine refuses a child process the build, so `stage` stops after install
 * and writes {@link BUILD_REQUEST_FILENAME}. The console builds the requested slot, and this
 * completes the same sequence the automatic path takes: confirm the tree is still the
 * requested version, smoke-test the artifacts that were built, and record the slot as staged.
 *
 * @param config - resolved tool configuration.
 * @param statePath - upgrade state file.
 * @param options - global options.
 * @returns the process exit code.
 */
async function resumeBuild(config: Config, statePath: string, options: RunOptions): Promise<number> {
  const fail = (code: number, message: string): number => {
    writeState(statePath, { ...readState(statePath), lastError: message })
    if (options.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message, nextAction: code === 3 ? 'human' : 'retry' })}\n`)
    else process.stderr.write(`dsh-upgrade stage: ${message}\n`)
    return code
  }
  const request = readBuildRequest(config)
  if (request === undefined) return fail(3, 'no build request; run "dsh-upgrade stage" first')
  if (activeSlot(config) === request.slot) return fail(3, `slot ${request.slot} is serving; refusing to finish a build there`)
  if (!slotExists(config, request.slot)) return fail(3, `slot ${request.slot} has no checkout; run "dsh-upgrade stage"`)
  const directory = slotPath(config, request.slot)
  const at = tagsAtHead(directory)
  if (!at.includes(request.tag)) {
    return fail(3, `slot ${request.slot} is at ${at.join(', ') || 'an untagged commit'}, not ${request.tag}; run "dsh-upgrade stage" again`)
  }
  if (!existsSync(join(directory, '.dsh-build', 'client-build-environment.json'))) {
    return fail(3, 'the build has not finished: no .dsh-build record; run the build in an administrator console')
  }
  // The build record is untracked, so it survives a checkout of a different tag. `stage` deletes
  // it when it writes the request; this timestamp check catches a record that is older than the
  // request for any other reason (a restored folder, a hand-written request).
  try {
    const recordAge = statSync(join(directory, '.dsh-build', 'client-build-environment.json')).mtimeMs
    const requestAge = statSync(join(config.root, 'state', BUILD_REQUEST_FILENAME)).mtimeMs
    if (recordAge + 1000 < requestAge) {
      return fail(3, 'the build record is older than the request; run the build again in an administrator console')
    }
  } catch (error) {
    return fail(3, `the build request could not be checked: ${(error as Error).message}`)
  }
  const progress = (line: string): void => { if (!options.json) process.stderr.write(`${line}\n`) }
  progress(`smoke testing the built ${request.tag} in slot ${request.slot}`)
  const smoked = await smoke(config, directory, join(config.root, 'logs', `smoke-${request.tag}.log`), progress)
  if (!smoked.ok) return fail(4, `smoke failed: ${smoked.error ?? 'unknown'}`)
  const record: SlotRecord = {
    tag: request.tag,
    slot: request.slot,
    at: new Date().toISOString(),
    ...clientRecordOf(directory),
  }
  writeState(statePath, { ...readState(statePath), staged: record, lastError: null })
  rmSync(join(config.root, 'state', BUILD_REQUEST_FILENAME), { force: true })
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, resumed: true, tag: record.tag, slot: record.slot, smoke: true, nextAction: 'apply' })}\n`)
  } else {
    process.stdout.write(`staged ${request.tag} in slot ${request.slot} (built in an administrator console, smoke passed)\nNext: dsh-upgrade apply\n`)
  }
  return 0
}

/**
 * Run `stage`.
 * @param args - arguments after the command name.
 * @param options - global options.
 * @returns the process exit code.
 */
export async function runStage(args: readonly string[], options: RunOptions): Promise<number> {
  let flags: StageFlags
  try {
    flags = parseFlags(args)
  } catch (error) {
    process.stderr.write(`dsh-upgrade stage: ${(error as Error).message}\n`)
    return 2
  }

  const configPath = resolveConfigPath(options.configPath, options.cwd, options.toolRoot)
  if (!existsSync(configPath)) {
    process.stderr.write(`dsh-upgrade stage: ${configPath} not found (run "dsh-upgrade init")\n`)
    return 4
  }
  const config = loadConfig(configPath)
  const statePath = statePathOf(config)
  let state = readState(statePath)
  const progress = (line: string): void => { if (!options.json) process.stderr.write(`${line}\n`) }
  const fail = (code: number, message: string): number => {
    state = { ...state, lastError: message }
    writeState(statePath, state)
    if (options.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message, nextAction: code === 3 ? 'human' : 'retry' })}\n`)
    else process.stderr.write(`dsh-upgrade stage: ${message}\n`)
    return code
  }

  const lock = acquireLock(join(config.root, 'state', 'layout.lock'))
  if (lock === undefined) return fail(3, 'another layout action is running (state/layout.lock is held)')

  try {
    if (flags.resume) return await resumeBuild(config, statePath, options)
    const active = activeSlot(config)
    const slot = spareSlot(config)
    const directory = slotPath(config, slot)
    if (resolve(directory) !== resolve(config.slotsRoot, slot)) return fail(3, `refusing to write ${directory}`)
    if (!resolve(directory).startsWith(`${resolve(config.slotsRoot)}${sep}`)) return fail(3, `slot path escapes ${config.slotsRoot}`)
    if (active === slot) return fail(3, `spare slot resolved to the serving slot (${slot})`)
    // `spareSlot` falls back to `a` when the stable path is missing or is not a link. That is
    // correct on a fresh machine, but if a server is already listening, its slot is unknown and
    // writing to `a` could be writing to the tree that server is running from.
    const link = describeLink(config.stablePath)
    if (link.kind === 'directory') {
      return fail(3, `${config.stablePath} is a real directory; the tool only replaces a junction (move it aside and run "init")`)
    }
    if (active === undefined && portOwner(config.webPort) !== undefined) {
      return fail(3, `something is serving on ${config.webPort} but ${config.stablePath} is not a slot junction; stop it or repair the link before staging`)
    }

    if (flags.fetch) {
      const repo = slotExists(config, active === undefined ? 'a' : active) ? slotPath(config, active === undefined ? 'a' : active) : undefined
      if (repo !== undefined) {
        const fetched = fetchTags(repo, config.upstream)
        if (!fetched.ok) return fail(4, `git fetch failed: ${fetched.stderr.trim()}`)
      }
    }
    // With a local slot the tags are already fetched; without one, ask the remote directly.
    const localRepo = active !== undefined && slotExists(config, active) ? slotPath(config, active)
      : slotExists(config, 'a') ? slotPath(config, 'a')
      : slotExists(config, 'b') ? slotPath(config, 'b')
      : undefined
    const tags = localRepo === undefined ? lsRemoteTags(config.upstream, config.root) : listTags(localRepo, config.tagPattern)
    const target = flags.tag ?? newestTag(tags, config.tagPattern)?.tag
    if (target === undefined) return fail(4, `no tag matching ${config.tagPattern} in ${config.slotsRoot}`)
    if (flags.tag !== undefined) {
      if (!globMatches(config.tagPattern, flags.tag)) {
        return fail(2, `--tag ${flags.tag} does not match ${config.tagPattern}`)
      }
      const deployed = state.deployed
      if (deployed !== null && !flags.force) {
        const requested = parseTag(target, config.tagPattern)
        const current = parseTag(deployed.tag, config.tagPattern)
        if (requested !== undefined && current !== undefined && compareVersions(requested, current) <= 0) {
          return fail(3, `refusing to prepare ${target}: it is not newer than the deployed ${deployed.tag} (use --force to override)`)
        }
      }
    }

    // Reuse a slot only when nothing would have to change in it: no patch can have been added
    // since, and the state still records this exact version in this slot as staged.
    const reused = !flags.force
      && config.patchFiles.length === 0
      && isPrepared(config, slot, target)
      && state.staged?.tag === target
      && state.staged?.slot === slot
    if (reused) {
      progress(`slot ${slot} is already prepared at ${target}`)
      state = { ...state, staged: { ...state.staged, at: new Date().toISOString() } as SlotRecord, lastError: null }
      writeState(statePath, state)
      if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, tag: target, slot, alreadyPrepared: true })}\n`)
      return 0
    }

    progress(`preparing ${target} in slot ${slot}`)
    ensureCheckout(config, slot, target, progress)

    const patches = applyPatches(config, directory, options.toolRoot, progress, target)
    if (!patches.ok) return fail(3, patches.error ?? 'patch failed')

    if (!flags.skipInstall) {
      progress('installing dependencies')
      const installed = await install(config, directory, join(config.root, 'logs', `stage-${target}.log`), progress)
      if (installed.timedOut) return fail(4, 'pnpm install timed out')
      if (installed.code !== 0) return fail(4, `pnpm install failed (${installed.code}): ${installed.tail.slice(-8).join(' | ')}`)
    }

    if (!flags.skipBuild) {
      if (config.manualBuild) {
        // A build record from an earlier tag survives `checkout --force`; drop it so `--resume`
        // can only ever smoke the build this request asks for.
        rmSync(join(directory, '.dsh-build'), { recursive: true, force: true })
        mkdirSync(join(config.root, 'state'), { recursive: true })
        writeFileSync(join(config.root, 'state', BUILD_REQUEST_FILENAME), `${JSON.stringify({ tag: target, slot, at: new Date().toISOString() }, null, 2)}\n`, 'utf8')
        return fail(3, `this machine builds only from an administrator console; run the build there or set manualBuild=false`)
      }
      progress('building')
      const built = await build(config, directory, join(config.root, 'logs', `stage-${target}.log`))
      if (built.timedOut) return fail(4, 'pnpm run build timed out')
      if (built.code !== 0) return fail(4, `pnpm run build failed (${built.code}): ${built.tail.slice(-8).join(' | ')}`)
    }

    progress('smoke testing')
    const smoked = await smoke(config, directory, join(config.root, 'logs', `smoke-${target}.log`), progress)
    if (!smoked.ok) return fail(4, `smoke failed: ${smoked.error ?? 'unknown'}`)

    const record: SlotRecord = {
      tag: target,
      slot,
      at: new Date().toISOString(),
      ...clientRecordOf(directory),
    }
    state = { ...state, staged: record, lastError: null }
    writeState(statePath, state)
    if (options.json) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        tag: target,
        slot,
        smoke: true,
        clientVersion: record.clientVersion ?? null,
        clientArtifacts: record.clientArtifacts ?? null,
        patches: { applied: patches.applied, alreadyApplied: patches.alreadyApplied },
        nextAction: 'apply',
      })}\n`)
    } else {
      process.stdout.write(`staged ${target} in slot ${slot} (smoke passed)\nNext: dsh-upgrade apply\n`)
    }
    return 0
  } catch (error) {
    return fail(4, (error as Error).message)
  } finally {
    lock.release()
  }
}



