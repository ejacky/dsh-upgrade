#!/usr/bin/env node
/**
 * `dsh-upgrade` command-line entry.
 *
 * Scope of this milestone (M0): the command surface, exit-code contract, `--help`,
 * `--version`, and `--json`. Every other command is listed by `--help` and refuses to run
 * with {@link EXIT.unimplemented} until its milestone lands, so the surface can be reviewed
 * and scripted against before the engine exists.
 *
 * The tool upgrades a DeepSeek Harness **source checkout**: two slot checkouts (`a`/`b`)
 * behind a stable-path junction, a read-only serving slot, and exactly one writer at a time.
 * It never touches the serving slot while preparing a version, and it never switches on its
 * own.
 *
 * @module dsh-upgrade/cli
 */
import { join } from 'node:path'
import { readToolVersion } from './version.ts'
import { runCheck } from './commands/check.ts'
import { runInit } from './commands/init.ts'
import { runStage } from './commands/stage.ts'
import { runStatus } from './commands/status.ts'

/** Documented exit codes. Scripts and the tray app branch on these. */
const EXIT = {
  /** The command completed. */
  ok: 0,
  /** The invocation itself was wrong (unknown command, bad arguments). */
  usage: 2,
  /** Progress needs a human (for example: the build must run from an elevated console). */
  manual: 3,
  /** An environment probe in `doctor` did not pass. */
  probe: 4,
  /** The command is part of the v1 surface but its milestone has not landed yet. */
  unimplemented: 5,
} as const

/** One entry of the command surface. */
interface CommandSpec {
  /** One-line description shown by `--help`. */
  readonly summary: string
  /** `false` while the command is still a stub that exits with {@link EXIT.unimplemented}. */
  readonly implemented: boolean
  /** Argument hint shown after the command name. */
  readonly usage?: string
  /** Runs the command; returns the process exit code. */
  run?: (args: readonly string[], options: RunOptions) => number | Promise<number>
}

/** Global options already parsed out of argv. */
export interface RunOptions {
  /** `--json`: emit machine-readable output where the command supports it. */
  readonly json: boolean
  /** Directory the invocation ran from; relative paths resolve against it. */
  readonly cwd: string
  /** The tool's own install directory, the last resort for locating its config. */
  readonly toolRoot: string
  /** `--config <path>` when given; commands resolve their own default otherwise. */
  readonly configPath?: string
}

const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  version: {
    summary: 'print this tool version',
    implemented: true,
    run: (_args, options) => printVersion(options),
  },
  init: {
    summary: 'create the dual-slot layout, the stable-path link, and the config file',
    usage: '[--root <dir>] [--upstream <url>] [--force]',
    implemented: true,
    run: runInit,
  },
  status: { summary: 'report versions, slots, staged version, and the last error', implemented: true, run: runStatus },
  check: { summary: 'fetch upstream tags and report whether a newer version exists', usage: '[--no-fetch]', implemented: true, run: runCheck },
  stage: {
    summary: 'prepare the spare slot and smoke-test it, without touching the serving slot',
    usage: '[--tag <tag>] [--skip-build] [--skip-install] [--force] [--no-fetch]',
    implemented: true,
    run: runStage,
  },
  apply: { summary: 'switch to the staged version; rolls back automatically when startup fails', implemented: false },
  rollback: { summary: 'switch back to the previous version', implemented: false },
  toggle: { summary: 'stop the web server when it runs, otherwise start it (one-icon behaviour)', implemented: false },
  start: { summary: 'start the web server and wait until it answers', implemented: false },
  stop: { summary: 'stop the web server', implemented: false },
  doctor: { summary: 'probe the machine and report what needs fixing', usage: '[--live]', implemented: false },
  'opencode-session': {
    summary: 'install, remove, or report the bundled x-opencode-session plugin',
    usage: '[install|remove|status|disable]',
    implemented: false,
  },
  patch: { summary: 'list, verify, add, or remove source patches', usage: '[list|verify|add|remove]', implemented: false },
  shortcuts: { summary: 'create or remove the desktop and taskbar launchers', usage: '[--install|--remove]', implemented: false },
  tray: { summary: 'run the tray companion', implemented: false },
  task: { summary: 'install, remove, or report the scheduled check task', usage: '[install|remove|status]', implemented: false },
  log: { summary: 'print the recent log lines', usage: '[--tail <n>]', implemented: false },
}

/**
 * Render and print the command surface.
 * @param stream - where to write (stdout for `--help`, stderr for a usage error).
 */
function printHelp(stream: NodeJS.WriteStream, root: string): void {
  const body: string[] = []
  for (const [name, spec] of Object.entries(COMMANDS)) {
    const usage = spec.usage === undefined ? '' : ` ${spec.usage}`
    const pending = spec.implemented ? '' : ' (not implemented yet)'
    body.push(`  ${name}${usage}`, `      ${spec.summary}${pending}`)
  }
  const lines = [
    'dsh-upgrade — zero-downtime upgrades for a DeepSeek Harness source checkout',
    '',
    'Usage:',
    '  dsh-upgrade <command> [options]',
    '',
    'Commands:',
    ...body,
    '',
    'Global options:',
    '  -h, --help       show this help',
    '  -V, --version    print the tool version',
    '  --json           machine-readable output where supported',
    '',
    'Exit codes:',
    `  ${EXIT.ok}  success        ${EXIT.usage}  usage error`,
    `  ${EXIT.manual}  needs a human  ${EXIT.probe}  probe failed`,
    `  ${EXIT.unimplemented}  command not implemented yet`,
    '',
    `Root: ${root}`,
  ]
  stream.write(`${lines.join('\n')}\n`)
}

/**
 * Print the tool version.
 * @param options - parsed global options.
 * @returns {@link EXIT.ok}.
 */
function printVersion(options: Pick<RunOptions, 'json'>): number {
  const info = readToolVersion(import.meta.dirname)
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ name: info.name, version: info.version, schema: info.schema, builtAt: info.builtAt })}\n`)
    return EXIT.ok
  }
  process.stdout.write(`${info.name} ${info.version}\n`)
  return EXIT.ok
}

/** Global flags pulled out before the command name. */
interface GlobalFlags {
  readonly json: boolean
  readonly help: boolean
  readonly version: boolean
  readonly configPath?: string
  readonly rest: readonly string[]
}

/**
 * Split global flags from the remaining argv, leaving `--` passthrough intact.
 * @param argv - arguments after the script path.
 * @returns the parsed global flags and the untouched remainder.
 */
function parseGlobal(argv: readonly string[]): GlobalFlags {
  let json = false
  let help = false
  let version = false
  let configPath: string | undefined
  const rest: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) continue
    if (argument === '--') {
      rest.push(...argv.slice(index + 1))
      break
    }
    if (argument === '--json') { json = true; continue }
    if (argument === '-h' || argument === '--help') { help = true; continue }
    if (argument === '-V' || argument === '--version') { version = true; continue }
    if (argument === '--config') {
      const value = argv[index + 1]
      if (value === undefined || value === '') throw new Error('--config needs a path')
      configPath = value
      index += 1
      continue
    }
    rest.push(argument)
  }
  return { json, help, version, rest, ...configPath === undefined ? {} : { configPath } }
}

/**
 * Run one invocation.
 * @param argv - arguments after the script path.
 * @returns the process exit code.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const flags = parseGlobal(argv)
  if (flags.version) return printVersion({ json: flags.json })

  const root = process.cwd()
  const [name, ...args] = flags.rest
  if (name === undefined || flags.help) {
    printHelp(process.stdout, root)
    return EXIT.ok
  }
  if (name === 'help') {
    const target = args[0]
    if (target === undefined) {
      printHelp(process.stdout, root)
      return EXIT.ok
    }
    const spec = COMMANDS[target]
    if (spec === undefined) return usageError(`unknown command "${target}"`)
    process.stdout.write(`${target}${spec.usage === undefined ? '' : ` ${spec.usage}`} — ${spec.summary}\n`)
    return EXIT.ok
  }

  const spec = COMMANDS[name]
  if (spec === undefined) return usageError(`unknown command "${name}"`)
  if (!spec.implemented || spec.run === undefined) {
    process.stderr.write(`dsh-upgrade: command "${name}" is not implemented yet\n`)
    return EXIT.unimplemented
  }
  return await spec.run(args, {
    json: flags.json,
    cwd: process.cwd(),
    toolRoot: join(import.meta.dirname, '..'),
    ...flags.configPath === undefined ? {} : { configPath: flags.configPath },
  })
}

/**
 * Report a usage error on stderr with a pointer to `--help`.
 * @param message - what was wrong.
 * @returns {@link EXIT.usage}.
 */
function usageError(message: string): number {
  process.stderr.write(`dsh-upgrade: ${message}\nRun "dsh-upgrade --help" for the command list.\n`)
  return EXIT.usage
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))



