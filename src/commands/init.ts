/**
 * `init`: establish the layout and write the configuration.
 *
 * Deliberately does not clone anything: obtaining the first slot and building it is
 * `stage`'s job, so `init` stays fast, offline, and repeatable on a machine whose slots
 * already exist.
 *
 * @module dsh-upgrade/commands/init
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defaultConfig, saveConfig, type Config } from '../engine/config.ts'
import { writeState, readState, statePathOf } from '../engine/state.ts'
import { activeSlot } from '../engine/slots.ts'
import type { RunOptions } from '../cli.ts'

/** Global flags this command understands. */
interface InitFlags {
  readonly root?: string
  readonly upstream?: string
  readonly force: boolean
}

/**
 * Parse `init` arguments.
 * @param args - arguments after the command name.
 * @returns the parsed flags.
 * @throws when a flag is unknown or lacks a value.
 */
function parseFlags(args: readonly string[]): InitFlags {
  let root: string | undefined
  let upstream: string | undefined
  let force = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--force') { force = true; continue }
    if (argument === '--root' || argument === '--upstream') {
      const value = args[index + 1]
      if (value === undefined) throw new Error(`${argument} needs a value`)
      if (argument === '--root') root = value
      else upstream = value
      index += 1
      continue
    }
    throw new Error(`unknown argument "${argument}"`)
  }
  return { ...root === undefined ? {} : { root }, ...upstream === undefined ? {} : { upstream }, force }
}

/**
 * Run `init`.
 * @param args - arguments after the command name.
 * @param options - global options.
 * @returns the process exit code.
 */
export function runInit(args: readonly string[], options: RunOptions): number {
  let flags: InitFlags
  try {
    flags = parseFlags(args)
  } catch (error) {
    process.stderr.write(`dsh-upgrade init: ${(error as Error).message}\n`)
    return 2
  }

  const configPath = options.configPath ?? join(flags.root === undefined ? options.cwd : resolve(options.cwd, flags.root), 'dsh-upgrade.json')
  if (existsSync(configPath) && !flags.force) {
    process.stderr.write(`dsh-upgrade init: ${configPath} already exists (pass --force to rewrite)\n`)
    return 2
  }

  const baseDir = resolve(configPath, '..')
  const config: Config = flags.root === undefined
    ? defaultConfig({ root: options.cwd, ...flags.upstream === undefined ? {} : { upstream: flags.upstream } })
    : defaultConfig({
      root: resolve(options.cwd, flags.root),
      ...flags.upstream === undefined ? {} : { upstream: flags.upstream },
    })

  for (const directory of [config.root, config.slotsRoot, join(config.root, 'state'), join(config.root, 'logs')]) {
    mkdirSync(directory, { recursive: true })
  }
  saveConfig(configPath, config)
  const statePath = statePathOf(config)
  if (!existsSync(statePath)) writeState(statePath, readState(statePath))

  const active = activeSlot(config)
  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      configPath,
      baseDir,
      config,
      activeSlot: active ?? null,
      next: active === undefined ? ['stage a version to create the first slot'] : [],
    })}\n`)
    return 0
  }
  process.stdout.write([
    `wrote ${configPath}`,
    `  root        ${config.root}`,
    `  stable path ${config.stablePath}`,
    `  slots       ${config.slotsRoot}`,
    `  upstream    ${config.upstream}`,
    active === undefined ? '  serving     (no slot yet; run "dsh-upgrade stage")' : `  serving     slot ${active}`,
    '',
    'Next:',
    '  dsh-upgrade check      see whether a version is available',
    '  dsh-upgrade stage      prepare the spare slot',
  ].join('\n') + '\n')
  return 0
}
