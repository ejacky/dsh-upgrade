/**
 * `task`: the periodic watcher that follows upstream tags.
 *
 * The watcher checks for a newer tag and, when one exists, prepares the spare slot. It never
 * switches versions — an upgrade stays a deliberate act from the launcher or the command line,
 * because a background process must not restart the server a person is using.
 *
 * Windows registers a Task Scheduler entry through PowerShell's cmdlets rather than `schtasks`,
 * whose output is localized and whose password prompt would hang a hidden wrapper. Elsewhere
 * the watcher is a systemd user timer: two unit files, `enable --now`, and `systemctl status`
 * as the proof that it exists.
 *
 * @module dsh-upgrade/commands/task
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RunOptions } from '../cli.ts'
import { loadConfig, resolveConfigPath, type Config } from '../engine/config.ts'
import { cliEntryPath } from '../engine/entry.ts'
import { IS_WINDOWS, systemdUserDirectory } from '../engine/host.ts'
import { readState, statePathOf } from '../engine/state.ts'

/** Exit codes; see `src/cli.ts` for the contract. */
const EXIT = { ok: 0, usage: 2, manual: 3, probe: 4 } as const

/** Default task name; matches the task the legacy PowerShell tool registered. */
const DEFAULT_TASK_NAME = 'DshUpstreamUpgrade'

/** Minutes between checks. */
const DEFAULT_INTERVAL_MINUTES = 20

/** Lower bound that keeps a watcher from competing with a person's own staging run. */
const MIN_INTERVAL_MINUTES = 5

/** Upper bound: a year. A repeated task is not a one-shot; a larger value is a typo. */
const MAX_INTERVAL_MINUTES = 365 * 24 * 60

/** What systemd accepts as a unit name. A leading `-` would be read as a command option. */
const UNIT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

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
  /** `--s4u`: run whether or not the account is logged on (Windows only). */
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
      if (!Number.isSafeInteger(parsed) || parsed > MAX_INTERVAL_MINUTES) {
        throw new Error(`--interval must be at most ${MAX_INTERVAL_MINUTES} minutes`)
      }
      if (parsed < MIN_INTERVAL_MINUTES) {
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
  // Only `install` has a dry run; accepting the flag elsewhere would look like a rehearsal of a
  // destructive command.
  if (chosen !== 'install' && dryRun) throw new Error('--dry-run only applies to "task install"')
  return { verb: chosen, interval, s4u, dryRun, name }
}

/** Where the wrapper (Windows) or the unit files (systemd) and the log live. */
interface TaskPaths {
  /** Watcher log, one line per run. */
  readonly log: string
  /** The CLI entry the watcher runs. */
  readonly cli: string
  /** Resolved configuration file, passed to every run. */
  readonly configPath: string
  /** Hidden `wscript` launcher; Windows only. */
  readonly wrapper?: string
  /** systemd oneshot unit that runs one pass; POSIX only. */
  readonly serviceUnit?: string
  /** systemd timer that starts the service; POSIX only. */
  readonly timerUnit?: string
}

/**
 * Resolve the wrapper or the units, the log, and the command the watcher runs.
 * @param config - resolved tool configuration.
 * @param configPath - the configuration file in use.
 * @param name - task name, which names the systemd units.
 */
function pathsOf(config: Config, configPath: string, name: string): TaskPaths {
  const shared = { log: join(config.root, 'logs', 'watch.log'), cli: cliEntryPath(), configPath }
  if (IS_WINDOWS) return { ...shared, wrapper: join(config.root, 'bin', 'dsh-upgrade-task.vbs') }
  const directory = systemdUserDirectory()
  return {
    ...shared,
    serviceUnit: join(directory, `${unitName(name)}.service`),
    timerUnit: join(directory, `${unitName(name)}.timer`),
  }
}

/**
 * Turn a task name into a systemd unit name.
 * @param name - the configured task name.
 * @returns a name systemd accepts.
 */
function unitName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]+/g, '-')
}

/**
 * PowerShell that registers the task, with the wrapper as the only action.
 * @param wrapper - the `.vbs` launcher.
 * @param flags - parsed arguments.
 */
function registerScript(wrapper: string, flags: TaskFlags): string {
  const quoting = (value: string): string => `'${value.replaceAll("'", "''")}'`
  return [
    '$ErrorActionPreference = "Stop"',
    `$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ${quoting(`"${wrapper}"`)}`,
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
 * Run `systemctl --user` and capture its output.
 * @param args - arguments after `--user`.
 * @param timeoutMs - upper bound.
 */
function systemctl(args: readonly string[], timeoutMs = 60_000): { code: number, stdout: string, stderr: string } {
  const result = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', timeout: timeoutMs })
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: (result.stderr ?? '') + (result.error === undefined ? '' : result.error.message),
  }
}

/**
 * The hidden wrapper: `wscript` reads UTF-16LE, so a path with non-ASCII characters survives.
 * @param cli - absolute path of the CLI entry.
 * @param configPath - the configuration file in use.
 * @param wrapper - the `.vbs` launcher being written.
 */
function wrapperSource(cli: string, configPath: string, wrapper: string): string {
  const command = `"${process.execPath}" "${cli}" task --run --config "${configPath}"`
  return `\uFEFF${[
    "' Runs one watcher pass with no console window.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${dirname(wrapper)}"`,
    `sh.Run "${command.replaceAll('"', '""')}", 0, True`,
    '',
  ].join('\r\n')}`
}

/**
 * Reject a value a unit file cannot carry.
 *
 * A newline would end the directive and a NUL is not representable; either one would produce a
 * unit that systemd reads differently from what this tool meant.
 * @param value - the value to check.
 * @returns the value, unchanged.
 * @throws when the value contains a newline or a NUL.
 */
function unitSafe(value: string): string {
  if (/[\n\r\0]/.test(value)) throw new Error(`task: ${JSON.stringify(value)} cannot be written to a unit file`)
  return value
}

/**
 * Quote one systemd command argument.
 *
 * `ExecStart=` splits on whitespace and expands `$VAR` and `%` specifiers even inside quotes, so
 * both characters are doubled and the argument is quoted as a whole.
 * @param value - one argument.
 * @returns the quoted argument.
 */
function unitQuote(value: string): string {
  const escaped = unitSafe(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    // A replacement string treats `$$` as an escaped dollar, so the doubled form needs a
    // function; the literal result is what systemd reads as one dollar.
    .replaceAll('$', () => '$$')
    .replaceAll('%', '%%')
  return `"${escaped}"`
}

/**
 * Render a path for a systemd path directive such as `WorkingDirectory=`.
 *
 * A path directive takes the rest of the line verbatim: quotes would become part of the path,
 * which systemd then rejects as "not absolute". Only specifier expansion applies.
 * @param value - the absolute path.
 * @returns the directive value, without quotes.
 */
function unitPathValue(value: string): string {
  return unitSafe(value).replaceAll('%', '%%')
}

/**
 * The oneshot unit: one watcher pass per timer activation.
 * @param config - resolved tool configuration.
 * @param paths - resolved paths.
 * @returns the unit file's text.
 */
function serviceUnitText(config: Config, paths: TaskPaths): string {
  return [
    '[Unit]',
    'Description=dsh-upgrade upstream watcher',
    'After=default.target',
    '',
    '[Service]',
    'Type=oneshot',
    `WorkingDirectory=${unitPathValue(config.root)}`,
    // The user manager's PATH is not the login shell's, and staging needs git and pnpm on it.
    ...process.env['PATH'] === undefined || process.env['PATH'] === ''
      ? []
      : [`Environment=${unitQuote(`PATH=${process.env['PATH']}`)}`],
    `ExecStart=${[process.execPath, paths.cli, 'task', '--run', '--config', paths.configPath].map(unitQuote).join(' ')}`,
    '',
  ].join('\n')
}

/**
 * The timer unit: what makes the watcher periodic.
 * @param unit - the timer's unit name.
 * @param intervalMinutes - minutes between checks.
 * @returns the unit file's text.
 */
function timerUnitText(unit: string, intervalMinutes: number): string {
  return [
    '[Unit]',
    `Description=dsh-upgrade upstream check every ${intervalMinutes} minutes`,
    '',
    '[Timer]',
    'OnBootSec=1min',
    `OnUnitActiveSec=${intervalMinutes}min`,
    `Unit=${unit}.service`,
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n')
}

/**
 * Read `key=value` lines from `systemctl show`.
 * @param text - the command's standard output.
 * @returns the values by key.
 */
function parseKeyValues(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const equals = line.indexOf('=')
    if (equals <= 0) continue
    values[line.slice(0, equals)] = line.slice(equals + 1)
  }
  return values
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
 * Require the Windows wrapper path.
 * @param paths - resolved paths.
 * @returns the wrapper path.
 */
function requireWrapper(paths: TaskPaths): string {
  if (paths.wrapper === undefined) throw new Error('task: the wrapper path is missing on this platform')
  return paths.wrapper
}

/**
 * Require the systemd unit paths.
 * @param paths - resolved paths.
 * @returns both unit paths.
 */
function requireUnits(paths: TaskPaths): { service: string, timer: string } {
  if (paths.serviceUnit === undefined || paths.timerUnit === undefined) {
    throw new Error('task: the unit paths are missing on this platform')
  }
  return { service: paths.serviceUnit, timer: paths.timerUnit }
}

/**
 * Report the Windows scheduled task.
 * @param paths - resolved paths.
 * @param flags - parsed arguments.
 * @param options - global options.
 * @returns the exit code.
 */
function windowsStatus(paths: TaskPaths, flags: TaskFlags, options: RunOptions): number {
  const wrapper = requireWrapper(paths)
  const queried = powershell(statusScript(flags.name), 60_000)
  const report = parseTrailingJson(queried.stdout)
  if (report === undefined) {
    return reportFailure(`could not query task "${flags.name}": ${queried.stderr.trim() || 'no answer'}`, EXIT.probe, options.json)
  }
  const installed = report['installed'] === true
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, name: flags.name, installed, wrapper, ...report })}\n`)
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
    `  wrapper    ${wrapper}`,
  ].join('\n') + '\n')
  return EXIT.ok
}

/**
 * Report the systemd timer.
 * @param paths - resolved paths.
 * @param flags - parsed arguments.
 * @param options - global options.
 * @returns the exit code.
 */
/**
 * Read when a timer last fired and when it will fire next.
 *
 * `systemctl show` prints these as localized display strings, which a JSON consumer cannot use;
 * `list-timers --output=json` reports epoch microseconds, which it can.
 * @param unit - the timer's unit name, without the `.timer` suffix.
 * @returns ISO timestamps, `null` when the timer has not fired or the listing cannot be read.
 */
function timerTimestamps(unit: string): { last: string | null, next: string | null } {
  const listed = systemctl(['list-timers', '--all', '--output=json'])
  if (listed.code !== 0) return { last: null, next: null }
  let entries: { unit?: string, last?: number, next?: number }[]
  try {
    entries = JSON.parse(listed.stdout) as { unit?: string, last?: number, next?: number }[]
  } catch {
    return { last: null, next: null }
  }
  if (!Array.isArray(entries)) return { last: null, next: null }
  const entry = entries.find(candidate => candidate.unit === `${unit}.timer`)
  const toIso = (microseconds: number | undefined): string | null => {
    if (typeof microseconds !== 'number' || !Number.isFinite(microseconds) || microseconds <= 0) return null
    return new Date(Math.round(microseconds / 1000)).toISOString()
  }
  return { last: toIso(entry?.last), next: toIso(entry?.next) }
}

function linuxStatus(paths: TaskPaths, flags: TaskFlags, options: RunOptions): number {
  const units = requireUnits(paths)
  const installed = existsSync(units.service) && existsSync(units.timer)
  if (!installed) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, name: flags.name, installed: false, unit: units.timer })}\n`)
      return EXIT.ok
    }
    process.stdout.write([
      `dsh-upgrade task status — ${flags.name}`,
      '  installed  no',
      '  next       dsh-upgrade task install',
      `  unit       ${units.timer}`,
    ].join('\n') + '\n')
    return EXIT.ok
  }
  const unit = unitName(flags.name)
  const shown = systemctl(['show', `${unit}.timer`, '--property=ActiveState,SubState,UnitFileState,LoadState'])
  const fields = parseKeyValues(shown.stdout)
  const timerText = readFileSync(units.timer, 'utf8')
  const interval = /OnUnitActiveSec=(\d+)min/.exec(timerText)?.[1]
  const timestamps = timerTimestamps(unit)
  const serviceFields = parseKeyValues(systemctl(['show', `${unit}.service`, '--property=Result,ExecMainStatus']).stdout)
  const execStatus = serviceFields['ExecMainStatus']
  const parsedStatus = execStatus === undefined || execStatus === '' ? undefined : Number(execStatus)
  // A timer that never fired has no exit status to report; `0` would read as "ran fine".
  const lastResult = timestamps.last === null || parsedStatus === undefined || !Number.isFinite(parsedStatus)
    ? null
    : parsedStatus
  const report = {
    state: fields['ActiveState'] ?? 'unknown',
    subState: fields['SubState'] ?? null,
    lastRun: timestamps.last,
    lastResult,
    nextRun: timestamps.next,
    logonType: 'systemd-user',
    intervalMinutes: interval === undefined ? null : Number(interval),
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, name: flags.name, installed, unit: units.timer, ...report })}\n`)
    return EXIT.ok
  }
  process.stdout.write([
    `dsh-upgrade task status — ${flags.name}`,
    `  installed  yes`,
    `  state      ${report.state}`,
    `  interval   ${report.intervalMinutes === null ? 'unknown' : `${report.intervalMinutes} min`}`,
    `  last run   ${report.lastRun ?? 'never'}${report.lastResult === null ? '' : ` (exit ${report.lastResult})`}`,
    `  next run   ${report.nextRun ?? 'unknown'}`,
    `  logon      systemd user session`,
    `  unit       ${units.timer}`,
  ].join('\n') + '\n')
  return EXIT.ok
}

/**
 * Remove the Windows scheduled task and its wrapper.
 * @param paths - resolved paths.
 * @param flags - parsed arguments.
 * @param options - global options.
 * @returns the exit code.
 */
function windowsRemove(paths: TaskPaths, flags: TaskFlags, options: RunOptions): number {
  const wrapper = requireWrapper(paths)
  const quoting = (value: string): string => `'${value.replaceAll("'", "''")}'`
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$task = Get-ScheduledTask -TaskName ${quoting(flags.name)} -ErrorAction SilentlyContinue`,
    'if ($null -eq $task) { \'{"removed":false}\'; exit 0 }',
    `Unregister-ScheduledTask -TaskName ${quoting(flags.name)} -Confirm:$false`,
    '\'{"removed":true}\'',
  ].join('\n')
  const deleted = powershell(script, 60_000)
  const report = parseTrailingJson(deleted.stdout)
  if (deleted.code !== 0 || report === undefined) {
    // Keep the wrapper: the task may still be registered and pointing at it, and a registered
    // task with a deleted wrapper fails silently every time it fires.
    return reportFailure(`could not remove task "${flags.name}": ${deleted.stderr.trim() || 'no answer'}`, EXIT.probe, options.json)
  }
  const removed = report['removed'] === true
  rmSync(wrapper, { force: true })
  if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, name: flags.name, removed, wrapper })}\n`)
  else if (removed) process.stdout.write(`removed task ${flags.name} and its wrapper\n`)
  else process.stdout.write(`task ${flags.name} is not registered; wrapper removed\n`)
  return EXIT.ok
}

/**
 * Remove the systemd units.
 * @param paths - resolved paths.
 * @param flags - parsed arguments.
 * @param options - global options.
 * @returns the exit code.
 */
function linuxRemove(paths: TaskPaths, flags: TaskFlags, options: RunOptions): number {
  const units = requireUnits(paths)
  const unit = unitName(flags.name)
  const present = existsSync(units.service) || existsSync(units.timer)
  if (present) {
    const disabled = systemctl(['disable', '--now', `${unit}.timer`])
    if (disabled.code !== 0) {
      // Keep the files: a timer that could not be disabled may still fire, and deleting the
      // units would turn a reported failure into a silent one.
      return reportFailure(
        `could not disable ${unit}.timer: ${disabled.stderr.trim() || 'no answer'}; the units were left in place`,
        EXIT.manual,
        options.json,
      )
    }
    rmSync(units.service, { force: true })
    rmSync(units.timer, { force: true })
    const reloaded = systemctl(['daemon-reload'])
    if (reloaded.code !== 0) {
      return reportFailure(
        `the unit files were removed, but systemd did not reload them: ${reloaded.stderr.trim() || 'no answer'}`,
        EXIT.manual,
        options.json,
      )
    }
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, name: flags.name, removed: present, unit: units.timer })}\n`)
    return EXIT.ok
  }
  process.stdout.write(present
    ? `removed ${flags.name} and its systemd units\n`
    : `${flags.name} is not installed; nothing to remove\n`)
  return EXIT.ok
}

/**
 * Register the Windows scheduled task and prove it exists.
 * @param config - resolved tool configuration.
 * @param paths - resolved paths.
 * @param flags - parsed arguments.
 * @param options - global options.
 * @returns the exit code.
 */
function windowsInstall(config: Config, paths: TaskPaths, flags: TaskFlags, options: RunOptions): number {
  const wrapper = requireWrapper(paths)
  const source = wrapperSource(paths.cli, paths.configPath, wrapper)
  const script = registerScript(wrapper, flags)
  if (flags.dryRun) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, name: flags.name, wrapper, interval: flags.interval, s4u: flags.s4u, wrapperSource: source, registration: script })}\n`)
      return EXIT.ok
    }
    process.stdout.write([
      `wrapper  ${wrapper}`,
      source.replace(/^\uFEFF/, ''),
      '',
      'registration command:',
      '  pwsh -NoProfile -Command "<the script below>"',
      script,
    ].join('\n') + '\n')
    return EXIT.ok
  }

  mkdirSync(join(config.root, 'bin'), { recursive: true })
  mkdirSync(join(config.root, 'logs'), { recursive: true })
  writeFileSync(wrapper, source, 'utf16le')
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
  if (queried?.['installed'] !== true) {
    return reportFailure(
      `the task "${flags.name}" is not registered after install; the registration was accepted but had no effect. `
      + 'Run "dsh-upgrade task install" from an administrator console.',
      EXIT.manual,
      options.json,
    )
  }
  const interval = queried['intervalMinutes']
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, name: flags.name, interval: flags.interval, installed: true, wrapper, log: paths.log })}\n`)
    return EXIT.ok
  }
  process.stdout.write([
    `registered task ${flags.name} every ${flags.interval} minutes (${flags.s4u ? 'whether or not you are logged on' : 'while you are logged on'})`,
    `  wrapper  ${wrapper}`,
    `  log      ${paths.log}`,
    `  state    ${String(queried['state'] ?? 'unknown')}${interval === null || interval === undefined ? '' : `, every ${String(interval)} min`}`,
    '  the task prepares a new version; it never switches to it',
  ].join('\n') + '\n')
  return EXIT.ok
}

/**
 * Register the systemd timer and prove it exists.
 * @param config - resolved tool configuration.
 * @param paths - resolved paths.
 * @param flags - parsed arguments.
 * @param options - global options.
 * @returns the exit code.
 */
function linuxInstall(config: Config, paths: TaskPaths, flags: TaskFlags, options: RunOptions): number {
  const units = requireUnits(paths)
  const unit = unitName(flags.name)
  if (flags.s4u) {
    return reportFailure(
      '--s4u is Windows-only; a systemd user timer runs while the user session exists',
      EXIT.usage,
      options.json,
    )
  }
  const service = serviceUnitText(config, paths)
  const timer = timerUnitText(unit, flags.interval)
  const fail = (message: string): number => {
    // Units that were never proven to work are removed: `status` reads the files, so a leftover
    // unit would make it report an install that systemd rejected. `enable` may already have
    // created a wants symlink, which would outlive the files it points at.
    systemctl(['disable', '--now', `${unit}.timer`])
    rmSync(units.service, { force: true })
    rmSync(units.timer, { force: true })
    rmSync(join(dirname(units.timer), 'timers.target.wants', `${unit}.timer`), { force: true })
    return reportFailure(message, EXIT.manual, options.json)
  }
  if (flags.dryRun) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        name: flags.name,
        unit: units.timer,
        interval: flags.interval,
        s4u: false,
        serviceUnitText: service,
        timerUnitText: timer,
        registration: `systemctl --user enable --now ${unit}.timer`,
      })}\n`)
      return EXIT.ok
    }
    process.stdout.write([
      `service  ${units.service}`,
      service,
      `timer    ${units.timer}`,
      timer,
      'registration command:',
      `  systemctl --user enable --now ${unit}.timer`,
    ].join('\n') + '\n')
    return EXIT.ok
  }

  mkdirSync(dirname(units.service), { recursive: true })
  mkdirSync(join(config.root, 'logs'), { recursive: true })
  writeFileSync(units.service, service, 'utf8')
  writeFileSync(units.timer, timer, 'utf8')
  const reloaded = systemctl(['daemon-reload'])
  if (reloaded.code !== 0) {
    return fail(
      `could not reload the user units: ${reloaded.stderr.trim() || 'no answer'}. `
      + 'A systemd user session is required; run "task install --dry-run" to see the units a cron entry would need to reproduce.',
    )
  }
  // A unit systemd cannot parse is reported as `bad-setting`; catching it here is what keeps a
  // "registered" watcher that never runs from looking healthy.
  const serviceState = parseKeyValues(systemctl(['show', `${unit}.service`, '--property=LoadState']).stdout)
  if (serviceState['LoadState'] !== 'loaded') {
    return fail(
      `systemd rejected ${unit}.service (LoadState=${serviceState['LoadState'] ?? 'unknown'}); `
      + 'run "task install --dry-run" and check the unit it prints',
    )
  }
  const enabled = systemctl(['enable', '--now', `${unit}.timer`])
  if (enabled.code !== 0) {
    return fail(
      `could not enable ${unit}.timer: ${enabled.stderr.trim() || 'no answer'}. `
      + 'Run "dsh-upgrade task install" from a normal login session, or reproduce the unit with --dry-run.',
    )
  }
  // Prove the timer is active rather than trusting a silent `enable`.
  const shown = parseKeyValues(systemctl(['show', `${unit}.timer`, '--property=ActiveState,UnitFileState']).stdout)
  if (shown['ActiveState'] !== 'active') {
    return fail(`the timer ${unit}.timer is not active after install; it was enabled but did not start`)
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, name: flags.name, interval: flags.interval, installed: true, unit: units.timer, log: paths.log })}\n`)
    return EXIT.ok
  }
  process.stdout.write([
    `registered ${unit}.timer every ${flags.interval} minutes (while your user session exists)`,
    `  unit     ${units.timer}`,
    `  log      ${paths.log}`,
    '  the timer prepares a new version; it never switches to it',
    '  to keep it running while logged out: loginctl enable-linger "$USER"',
  ].join('\n') + '\n')
  return EXIT.ok
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
    if (!IS_WINDOWS && flags.verb !== 'run' && !UNIT_NAME.test(flags.name)) {
      return reportFailure(
        `"${flags.name}" is not a valid systemd unit name (letters, digits, "_", ".", "-"; it must not start with "-" or ".")`,
        EXIT.usage,
        options.json,
      )
    }
    const paths = pathsOf(config, configPath, flags.name)

    if (flags.verb === 'status') return IS_WINDOWS ? windowsStatus(paths, flags, options) : linuxStatus(paths, flags, options)
    if (flags.verb === 'remove') return IS_WINDOWS ? windowsRemove(paths, flags, options) : linuxRemove(paths, flags, options)
    if (flags.verb === 'run') return runOnce(config, configPath, paths, options)
    return IS_WINDOWS ? windowsInstall(config, paths, flags, options) : linuxInstall(config, paths, flags, options)
  } catch (error) {
    return reportFailure((error as Error).message, EXIT.probe, options.json)
  }
}
