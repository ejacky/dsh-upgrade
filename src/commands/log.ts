/**
 * `log`: the tail of what the tool recorded.
 *
 * Every long step writes a log file under `<root>\logs` (`stage-<tag>.log`,
 * `smoke-<tag>.log`, `start.log`, `watch.log`). When something fails the operator has the exit
 * code and one line of stderr; the reason is in those files. This command answers "what
 * happened" without making anyone guess a path, and `--list` shows what exists.
 *
 * @module dsh-upgrade/commands/log
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { RunOptions } from '../cli.ts'
import { loadConfig, resolveConfigPath, type Config } from '../engine/config.ts'

/** Exit codes; see `src/cli.ts` for the contract. */
const EXIT = { ok: 0, usage: 2, probe: 4 } as const

/** Lines shown when `--tail` is not given. */
const DEFAULT_TAIL = 40

/** Upper bound, so one command cannot print an unbounded file. */
const MAX_TAIL = 5000

/** Parsed `log` arguments. */
interface LogFlags {
  /** How many trailing lines to print. */
  readonly tail: number
  /** `--file <name or path>` picks a specific log. */
  readonly file?: string
  /** `--list` reports the available logs instead of printing one. */
  readonly list: boolean
}

/**
 * Parse `log` arguments.
 * @param args - arguments after the command name.
 */
function parseFlags(args: readonly string[]): LogFlags {
  let tail = DEFAULT_TAIL
  let file: string | undefined
  let list = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === undefined) continue
    if (argument === '--list') { list = true; continue }
    if (argument === '--file' || argument === '--tail') {
      const value = args[index + 1]
      if (value === undefined || value === '') throw new Error(`${argument} needs a value`)
      index += 1
      if (argument === '--file') { file = value; continue }
      const parsed = Number.parseInt(value, 10)
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error('--tail must be a positive line count')
      tail = Math.min(parsed, MAX_TAIL)
      continue
    }
    throw new Error(`unknown argument "${argument}"`)
  }
  if (list && file !== undefined) throw new Error('--list and --file cannot be combined')
  return { tail, list, ...file === undefined ? {} : { file } }
}

/** One log file the tool wrote. */
interface LogFile {
  /** File name, as shown by `--list`. */
  readonly name: string
  /** Absolute path. */
  readonly path: string
  /** Size in bytes. */
  readonly bytes: number
  /** Modification time, ISO. */
  readonly modified: string
}

/**
 * The log directory.
 * @param config - resolved tool configuration.
 */
function logDirectoryOf(config: Config): string {
  return join(config.root, 'logs')
}

/**
 * Every log file, newest first.
 * @param config - resolved tool configuration.
 */
function logFilesOf(config: Config): LogFile[] {
  const directory = logDirectoryOf(config)
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const path = join(directory, entry.name)
      const stats = statSync(path)
      return { name: entry.name, path, bytes: stats.size, modified: stats.mtime.toISOString(), at: stats.mtimeMs }
    })
    .sort((left, right) => right.at - left.at)
    .map(({ name, path, bytes, modified }) => ({ name, path, bytes, modified }))
}

/**
 * Print a failure on the channel the caller reads.
 * @param message - what went wrong.
 * @param code - exit code.
 * @param json - whether `--json` output was requested.
 */
function reportFailure(message: string, code: number, json: boolean): number {
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
  else process.stderr.write(`dsh-upgrade log: ${message}\n`)
  return code
}

/**
 * Run `log`.
 * @param args - arguments after the command name.
 * @param options - global options.
 * @returns the process exit code.
 */
export function runLog(args: readonly string[], options: RunOptions): number {
  let flags: LogFlags
  try {
    flags = parseFlags(args)
  } catch (error) {
    process.stderr.write(`dsh-upgrade log: ${(error as Error).message}\n`)
    return EXIT.usage
  }

  try {
    const configPath = resolveConfigPath(options.configPath, options.cwd, options.toolRoot)
    if (!existsSync(configPath)) return reportFailure(`${configPath} not found (run "dsh-upgrade init")`, EXIT.probe, options.json)
    const config = loadConfig(configPath)
    const files = logFilesOf(config)

    if (flags.list) {
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, directory: logDirectoryOf(config), files })}\n`)
        return EXIT.ok
      }
      if (files.length === 0) {
        process.stdout.write(`no logs yet under ${logDirectoryOf(config)}; "stage" and "apply" write them\n`)
        return EXIT.ok
      }
      process.stdout.write('dsh-upgrade log --list\n')
      for (const file of files) {
        const size = file.bytes >= 1024 ? `${Math.round(file.bytes / 1024)} KB` : `${file.bytes} B`
        process.stdout.write(`  ${file.modified.slice(0, 19).replace('T', ' ')}  ${size.padStart(8)}  ${file.name}\n`)
      }
      return EXIT.ok
    }

    if (files.length === 0) return reportFailure(`no logs yet under ${logDirectoryOf(config)}; "stage" and "apply" write them`, EXIT.probe, options.json)
    const chosen = flags.file === undefined
      ? files[0]
      : files.find(file => file.name === flags.file)
        ?? (isAbsolute(flags.file) || flags.file.includes('\\') || flags.file.includes('/')
          ? { name: flags.file, path: resolve(options.cwd, flags.file), bytes: 0, modified: '' }
          : undefined)
    if (chosen === undefined) return reportFailure(`no log named ${flags.file}; run "dsh-upgrade log --list"`, EXIT.probe, options.json)
    if (!existsSync(chosen.path)) return reportFailure(`no log at ${chosen.path}`, EXIT.probe, options.json)

    const text = readFileSync(chosen.path, 'utf8')
    const lines = text.split(/\r?\n/).filter((line, index, all) => line !== '' || index < all.length - 1).slice(-flags.tail)
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, file: chosen.path, name: chosen.name, lines })}\n`)
      return EXIT.ok
    }
    process.stdout.write(`==> ${chosen.path} (last ${lines.length} lines)\n`)
    process.stdout.write(`${lines.join('\n')}${lines.length === 0 ? '' : '\n'}`)
    return EXIT.ok
  } catch (error) {
    return reportFailure((error as Error).message, EXIT.probe, options.json)
  }
}
