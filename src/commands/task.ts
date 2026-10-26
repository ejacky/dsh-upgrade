/**
 * `task`: the periodic watcher that follows upstream tags.
 *
 * The task runs `task --run` on a timer through a hidden `wscript` wrapper: it checks for a
 * newer tag and, when one exists, prepares the spare slot. It never switches versions — an
 * upgrade stays a deliberate act from the tray or the command line, because a background
 * process must not restart the server a person is using.
 *
 * Registration goes through PowerShell's scheduled-task cmdlets rather than `schtasks`,
 * whose output is localized and whose password prompt would hang a hidden wrapper.
 *
 * @module dsh-upgrade/commands/task
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RunOptions } from '../cli.ts'
import { loadConfig, resolveConfigPath, type Config } from '../engine/config.ts'
import { cliEntryPath } from '../engine/entry.ts'
import { readState, statePathOf } from '../engine/state.ts'

/** Exit codes; see `src/cli.ts` for the contract. */
const EXIT = { ok: 0, usage: 2, manual: 3, probe: 4 } as const

/** Default task name; matches the task the legacy PowerShell tool registered. */
const DEFAULT_TASK_NAME = 'DshUpstreamUpgrade'

/** Minutes between checks. */
const DEFAULT_INTERVAL_MINUTES = 20

/** Lower bound that keeps a watcher from competing with a person's own staging run. */
const MIN_INTERVAL_MINUTES = 5

/** Verbs this command accepts. */
const VERBS = ['install', 'remove', 'status', 'run'] as const

/** A `task` verb. */
type Verb = typeof VERBS[number]

/** Parsed `task` arguments. */
interface TaskFlags {
  /** Which verb to run; `status` when none was given. */
  readonly verb: Verb
  /** `--interval <minutes>` for `install`. */
  readonly interval: number
  /** `--s4u`: run whether or not the account is logged on. */
  readonly s4u: boolean
  /** `--dry-run`: print what would be registered, change nothing. */
  readonly dryRun: boolean
  /** `--name <task name>`. */
  readonly name: string
}

/**
 * Parse `task` arguments.
 * @param args - arguments after the command name.
 */
function parseFlags(args: readonly string[]): TaskFlags {
  let verb: Verb | undefined
  let interval = DEFAULT_INTERVAL_MINUTES
  let s4u = false
  let dryRun = false
  let name = DEFAULT_TASK_NAME
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === undefined) continue
    if (argument === '--s4u') { s4u = true; continue }
    if (argument === '--dry-run') { dryRun = true; continue }
    if (argument === '--interval' || argument === '--name') {
      const value = args[index + 1]
      if (value === undefined || value === '') throw new Error(`${argument} needs a value`)
      index += 1
      if (argument === '--name') { name = value; continue }
      const parsed = Number.parseInt(value, 10)
      if (!Number.isInteger(parsed) || parsed < MIN_INTERVAL_MINUTES) {
        throw new Error(`--interval must be at least ${MIN_INTERVAL_MINUTES} minutes`)
      }
      interval = parsed
      continue
    }
    if (argument.startsWith('-')) throw new Error(`unknown argument "${argument}"`)
    if (verb !== undefined) throw new Error(`unexpected argument "${argument}"`)
    if (!VERBS.includes(argument as Verb)) throw new Error(`unknown task command "${argument}" (expected ${VERBS.join(', ')})`)
    verb = argument as Verb
  }
  const chosen = verb ?? 'status'
  if (chosen !== 'install' && (s4u || interval !== DEFAULT_INTERVAL_MINUTES)) {
    throw new Error('--interval and --s4u only apply to "task install"')
  }
  return { verb: chosen, interval, s4u, dryRun, name }
}

/** Where the wrapper and its log live. */
interface TaskPaths {
  /** Hidden launcher the task runs. */
  readonly wrapper: string
  /** Watcher log, one line per run. */
  readonly log: string
  /** The CLI entry the wrapper runs. */
  readonly cli: string
  /** Resolved configuration file, passed to every run. */
  readonly configPath: string
}

/**
 * Resolve the wrapper, the log, and the command the wrapper runs.
 * @param config - resolved tool configuration.
 * @param configPath - the configuration file in use.
 */
function pathsOf(config: Config, configPath: string): TaskPaths {
  const bin = join(config.root, 'bin')
  return {
    wrapper: join(bin, 'dsh-upgrade-task.vbs'),
    log: join(config.root, 'logs', 'watch.log'),
    cli: cliEntryPath(),
    configPath,
  }
}

/**
 * PowerShell that registers the task, with the wrapper as the only action.
 * @param paths - resolved paths.
 * @param flags - parsed arguments.
 */
function registerScript(paths: TaskPaths, flags: TaskFlags): string {
  const quoting = (value: string): string => `'${value.replaceAll("'", "''")}'`
  return [
    '$ErrorActionPreference = "Stop"',
    `$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ${quoting(`"${paths.wrapper}"`)}`,
    // A ten-year repetition window stands in for "forever": MaxValue is rejected on some builds.
    `$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes ${flags.interval}) -RepetitionDuration (New-TimeSpan -Days 3650)`,
    '$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 60)',
    `$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType ${flags.s4u ? 'S4U' : 'Interactive'}`,
    `Register-ScheduledTask -TaskName ${quoting(flags.name)} -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null`,
  ].join('\n')
}

/**
 * PowerShell that reports the registered task as JSON.
 *
 * Parsed from the cmdlet objects rather than `schtasks` text: that output is localized, and a
 * status report that depends on the display language is not a status report.
 * @param name - task name.
 */
function statusScript(name: string): string {
  const quoting = (value: string): string => `'${value.replaceAll("'", "''")}'`
  return [
    '$ErrorActionPreference = "Stop"',
    `$task = Get-ScheduledTask -TaskName ${quoting(name)} -ErrorAction SilentlyContinue`,
    'if ($null -eq $task) { \'{"installed":false}\'; exit 0 }',
    `$info = Get-ScheduledTaskInfo -TaskName ${quoting(name)}`,
    '$trigger = @($task.Triggers)[0]',
    '$lastRun = $null',
    'if ($null -ne $info.LastRunTime -and $info.LastRunTime.Year -gt 1999) { $lastRun = $info.LastRunTime.ToUniversalTime().ToString("o") }',
    '$nextRun = $null',
    'if ($null -ne $info.NextRunTime -and $info.NextRunTime.Year -gt 1999) { $nextRun = $info.NextRunTime.ToUniversalTime().ToString("o") }',
    '$interval = $null',
    'if ($null -ne $trigger -and $null -ne $trigger.Repetition -and $trigger.Repetition.Interval) {',
    '  $match = [regex]::Match([string]$trigger.Repetition.Interval, \'^P(?:(\\d+)D)?T?(?:(\\d+)H)?(?:(\\d+)M)?$\')',
    '  if ($match.Success) { $interval = ([int]$match.Groups[1].Value * 1440) + ([int]$match.Groups[2].Value * 60) + [int]$match.Groups[3].Value }',
    '}',
    '[pscustomobject]@{',
    '  installed = $true',
    '  state = [string]$task.State',
    '  lastRun = $lastRun',
    '  lastResult = $info.LastTaskResult',
    '  nextRun = $nextRun',
    '  logonType = [string]$task.Principal.LogonType',
    '  intervalMinutes = $interval',
    '} | ConvertTo-Json -Compress',
  ].join('\n')
}

/**
 * Run a PowerShell program and capture its output.
 * @param script - PowerShell source.
 * @param timeoutMs - upper bound.
 */
function powershell(script: string, timeoutMs = 120_000): { code: number, stdout: string, stderr: string } {
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    timeout: timeoutMs,
  })
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: (result.stderr ?? '') + (result.error === undefined ? '' : result.error.message),
  }
}

/**
 * The hidden wrapper: `wscript` reads UTF-16LE, so a path with non-ASCII characters survives.
 * @param paths - resolved paths.
 */
function wrapperSource(paths: TaskPaths): string {
  const command = `"${process.execPath}" "${paths.cli}" task --run --config "${paths.configPath}"`
  return `\uFEFF${[
    "' Runs one watcher pass with no console window.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${dirname(paths.wrapper)}"`,
    `sh.Run "${command.replaceAll('"', '""')}", 0, True`,
    '',
  ].join('\r\n')}`
}

/**
 * Print a failure on the channel the caller reads.
 * @param message - what went wrong.
 * @param code - exit code.
 * @param json - whether `--json` output was requested.
 */
function reportFailure(message: string, code: number, json: boolean): number {
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message, nextAction: code === EXIT.manual ? 'human' : 'retry' })}\n`)
  else process.stderr.write(`dsh-upgrade task: ${message}\n`)
  return code
}

/**
 * One watcher pass: check, and stage when a newer tag exists.
 * @param config - resolved tool configuration.
 * @param configPath - the configuration file in use.
 * @param paths - resolved paths.
 * @param options - global options.
 * @returns `0` when the pass completed, whatever it found; `4` when the check itself failed.
 */
function runOnce(config: Config, configPath: string, paths: TaskPaths, options: RunOptions): number {
  const node = process.execPath
  const base = [paths.cli, '--config', configPath]
  const log = (line: string): void => {
    mkdirSync(join(config.root, 'logs'), { recursive: true })
    appendFileSync(paths.log, `${new Date().toISOString()} ${line}\n`, 'utf8')
  }
  const check = spawnSync(node, [...base, 'check', '--json'], { encoding: 'utf8', windowsHide: true })
  const checkReport = parseTrailingJson(check.stdout)
  if (checkReport === undefined || checkReport['ok'] !== true) {
    const reason = String(checkReport?.['error'] ?? check.stderr.trim() ?? 'unknown error')
    log(`check failed: ${reason}`)
    return reportFailure(`check failed: ${reason}`, EXIT.probe, options.json)
  }
  const candidate = checkReport['candidate']
  if (typeof candidate !== 'string' || candidate === '') {
    const current = checkReport['current']
    log(`no newer version (current ${typeof current === 'string' ? current : 'none'})`)
    if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, action: 'none', current: current ?? null })}\n`)
    return EXIT.ok
  }
  const staged = readState(statePathOf(config)).staged
  if (staged?.tag === candidate) {
    log(`${candidate} is already staged`)
    if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, action: 'none', staged: candidate })}\n`)
    return EXIT.ok
  }
  log(`preparing ${candidate}`)
  const stage = spawnSync(node, [...base, 'stage', '--json', '--tag', candidate], { encoding: 'utf8', windowsHide: true })
  const stageReport = parseTrailingJson(stage.stdout)
  const ok = stageReport?.['ok'] === true
  const reason = String(stageReport?.['error'] ?? stage.stderr.trim() ?? 'unknown error')
  log(ok ? `staged ${candidate}` : `stage failed: ${reason}`)
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok, action: ok ? 'staged' : 'failed', tag: candidate, error: ok ? null : reason })}\n`)
  }
  return ok ? EXIT.ok : EXIT.manual
}

/**
 * Read the last JSON object a CLI run printed.
 * @param text - captured standard output.
 */
function parseTrailingJson(text: string): Record<string, unknown> | undefined {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('{'))
  const last = lines.at(-1)
  if (last === undefined) return undefined
  try {
    return JSON.parse(last) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * Run `task`.
 * @param args - arguments after the command name.
 * @param options - global options.
 * @returns the process exit code.
 */
export function runTask(args: readonly string[], options: RunOptions): number {
  let flags: TaskFlags
  try {
    flags = parseFlags(args)
  } catch (error) {
    process.stderr.write(`dsh-upgrade task: ${(error as Error).message}\n`)
    return EXIT.usage
  }

  try {
    const configPath = resolveConfigPath(options.configPath, options.cwd, options.toolRoot)
    if (!existsSync(configPath)) return reportFailure(`${configPath} not found (run "dsh-upgrade init")`, EXIT.probe, options.json)
    const config = loadConfig(configPath)
    const paths = pathsOf(config, configPath)

    if (flags.verb === 'status') {
      const queried = powershell(statusScript(flags.name), 60_000)
      const report = parseTrailingJson(queried.stdout)
      if (report === undefined) {
        return reportFailure(`could not query task "${flags.name}": ${queried.stderr.trim() || 'no answer'}`, EXIT.probe, options.json)
      }
      const installed = report['installed'] === true
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, name: flags.name, installed, wrapper: paths.wrapper, ...report })}\n`)
        return EXIT.ok
      }
      process.stdout.write([
        `dsh-upgrade task status — ${flags.name}`,
        `  installed  ${installed ? 'yes' : 'no'}`,
        ...installed ? [
          `  state      ${String(report['state'] ?? 'unknown')}`,
          `  interval   ${report['intervalMinutes'] === null ? 'unknown' : `${String(report['intervalMinutes'])} min`}`,
          `  last run   ${String(report['lastRun'] ?? 'never')} (result ${String(report['lastResult'] ?? '?')})`,
          `  next run   ${String(report['nextRun'] ?? 'unknown')}`,
          `  logon      ${String(report['logonType'] ?? 'unknown')}`,
        ] : [`  next       dsh-upgrade task install`],
        `  wrapper    ${paths.wrapper}`,
      ].join('\n') + '\n')
      return EXIT.ok
    }

    if (flags.verb === 'remove') {
      const quoting = (value: string): string => `'${value.replaceAll("'", "''")}'`
      const script = [
        '$ErrorActionPreference = "Stop"',
        `$task = Get-ScheduledTask -TaskName ${quoting(flags.name)} -ErrorAction SilentlyContinue`,
        'if ($null -eq $task) { \'{"removed":false}\'; exit 0 }',
        `Unregister-ScheduledTask -TaskName ${quoting(flags.name)} -Confirm:$false`,
        '\'{"removed":true}\'',
      ].join('\n')
      const deleted = powershell(script, 60_000)
      rmSync(paths.wrapper, { force: true })
      const report = parseTrailingJson(deleted.stdout)
      if (deleted.code !== 0 || report === undefined) {
        return reportFailure(`could not remove task "${flags.name}": ${deleted.stderr.trim() || 'no answer'}`, EXIT.probe, options.json)
      }
      const removed = report['removed'] === true
      if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, name: flags.name, removed, wrapper: paths.wrapper })}\n`)
      else if (removed) process.stdout.write(`removed task ${flags.name} and its wrapper\n`)
      else process.stdout.write(`task ${flags.name} is not registered; wrapper removed\n`)
      return EXIT.ok
    }

    if (flags.verb === 'run') return runOnce(config, configPath, paths, options)

    const source = wrapperSource(paths)
    const script = registerScript(paths, flags)
    if (flags.dryRun) {
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, name: flags.name, wrapper: paths.wrapper, interval: flags.interval, s4u: flags.s4u, wrapperSource: source, registration: script })}\n`)
        return EXIT.ok
      }
      process.stdout.write([
        `wrapper  ${paths.wrapper}`,
        source.replace(/^\uFEFF/, ''),
        '',
        'registration command:',
        `  pwsh -NoProfile -Command "<the script below>"`,
        script,
      ].join('\n') + '\n')
      return EXIT.ok
    }

    mkdirSync(join(config.root, 'bin'), { recursive: true })
    mkdirSync(join(config.root, 'logs'), { recursive: true })
    writeFileSync(paths.wrapper, source, 'utf16le')
    const registered = powershell(script)
    if (registered.code !== 0) {
      return reportFailure(
        `could not register task "${flags.name}": ${registered.stderr.trim() || 'unknown error'}. `
        + 'Run "dsh-upgrade task install" from an administrator console.',
        EXIT.manual,
        options.json,
      )
    }
    // Prove the task is there, rather than trusting a silent registration.
    const queried = parseTrailingJson(powershell(statusScript(flags.name), 60_000).stdout)
    const interval = queried?.['intervalMinutes']
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, name: flags.name, interval: flags.interval, installed: queried?.['installed'] === true, wrapper: paths.wrapper, log: paths.log })}\n`)
      return EXIT.ok
    }
    process.stdout.write([
      `registered task ${flags.name} every ${flags.interval} minutes (${flags.s4u ? 'whether or not you are logged on' : 'while you are logged on'})`,
      `  wrapper  ${paths.wrapper}`,
      `  log      ${paths.log}`,
      `  state    ${String(queried?.['state'] ?? 'unknown')}${interval === null || interval === undefined ? '' : `, every ${String(interval)} min`}`,
      '  the task prepares a new version; it never switches to it',
    ].join('\n') + '\n')
    return EXIT.ok
  } catch (error) {
    return reportFailure((error as Error).message, EXIT.probe, options.json)
  }
}
