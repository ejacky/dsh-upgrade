/**
 * `toggle` / `start` / `stop`: the one-icon control of the serving web app.
 *
 * The tray (Windows) and the desktop launchers both call `toggle`, which starts the server when
 * the port is free and otherwise stops it. Stopping is destructive enough that it needs consent:
 * `--yes` (the tray asks in its own dialog), an interactive terminal, or — for a POSIX launcher,
 * which has no terminal — a desktop dialog.
 *
 * @module dsh-upgrade/commands/power
 */
import { spawnSync } from 'node:child_process'
import { accessSync, constants as fsConstants, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, resolveConfigPath, type Config } from '../engine/config.ts'
import { cliEntryPath } from '../engine/entry.ts'
import { IS_WINDOWS, iconDirectory, portFree, shortcutDirectory, waitPortFree } from '../engine/host.ts'
import { portOwner, startService, stopService, waitForService } from '../engine/service.ts'
import { activeSlot, slotPath } from '../engine/slots.ts'
import type { RunOptions } from '../cli.ts'

/**
 * Explain a busy port whose listener this account cannot name.
 *
 * `/proc` can see the socket but not the owner when it belongs to another user, so the tool must
 * say that instead of claiming nothing is running.
 * @param port - the busy port.
 * @returns one actionable sentence.
 */
function unidentifiedListener(port: number): string {
  return `${port} is in use by a process this account cannot identify; find it with "sudo ss -ltnp 'sport = :${port}'"`
}

/**
 * Whether a graphical session is available to answer a dialog.
 * @returns `true` when `DISPLAY` or `WAYLAND_DISPLAY` names a session.
 */
function hasDisplay(): boolean {
  const display = process.env['DISPLAY']
  const wayland = process.env['WAYLAND_DISPLAY']
  return (display !== undefined && display !== '') || (wayland !== undefined && wayland !== '')
}

/**
 * Find an executable on `PATH`.
 * @param name - executable name.
 * @returns its absolute path, or `undefined` when it is not there.
 */
function findExecutable(name: string): string | undefined {
  const path = process.env['PATH']
  if (path === undefined) return undefined
  for (const directory of path.split(':')) {
    if (directory === '') continue
    const candidate = join(directory, name)
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // Not in this directory; keep looking.
    }
  }
  return undefined
}

/**
 * Ask a yes/no question in a desktop dialog.
 *
 * A POSIX launcher starts with no terminal, so this is the only way to honour "ask before
 * switching". The first toolkit present is used; `undefined` means none is installed and the
 * caller must refuse rather than guess.
 * @param question - the sentence shown to the person.
 * @returns `true` for yes, `false` for no, `undefined` when no dialog tool exists.
 */
function guiQuestion(question: string): boolean | undefined {
  const title = 'DeepSeek Harness'
  const dialogs: readonly { readonly file: string, readonly args: readonly string[] }[] = [
    { file: 'zenity', args: ['--question', `--title=${title}`, `--text=${question}`] },
    { file: 'kdialog', args: ['--title', title, '--yesno', question] },
    { file: 'yad', args: [`--title=${title}`, `--text=${question}`, '--button=No:1', '--button=Yes:0'] },
    { file: 'xmessage', args: ['-center', '-title', title, '-buttons', 'No:1,Yes:0', '-default', 'No', question] },
  ]
  for (const dialog of dialogs) {
    if (findExecutable(dialog.file) === undefined) continue
    const result = spawnSync(dialog.file, [...dialog.args], { stdio: 'ignore' })
    if (result.error === undefined) return result.status === 0
  }
  return undefined
}

/**
 * Report that a launcher cannot ask without a dialog tool.
 * @param options - global options.
 * @returns the exit code (3: a person must install one or pass `--yes`).
 */
function noDialog(options: RunOptions): number {
  const message = 'no dialog tool found (install zenity, kdialog, yad, or xmessage), or pass --yes'
  if (options.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message, nextAction: 'human' })}\n`)
  else process.stderr.write(`dsh-upgrade toggle: ${message}\n`)
  return 3
}

/** Shared context for the three commands. */
interface PowerContext {
  readonly config: ReturnType<typeof loadConfig>
  readonly json: boolean
}

/**
 * Load the configuration both commands need.
 * @param options - global options.
 * @returns the context, or `undefined` after reporting a missing configuration.
 */
function contextOf(options: RunOptions): PowerContext | undefined {
  const configPath = resolveConfigPath(options.configPath, options.cwd, options.toolRoot)
  if (!existsSync(configPath)) {
    process.stderr.write(`dsh-upgrade: ${configPath} not found (run "dsh-upgrade init")\n`)
    return undefined
  }
  return { config: loadConfig(configPath), json: options.json }
}

/**
 * Start the serving slot's web app.
 * @param args - `--json` style flags are global; `start` takes none.
 * @param options - global options.
 * @returns the exit code.
 */
export async function runStart(args: readonly string[], options: RunOptions): Promise<number> {
  if (args.length > 0) {
    process.stderr.write(`dsh-upgrade start: unknown argument "${args[0]}"\n`)
    return 2
  }
  const context = contextOf(options)
  if (context === undefined) return 4
  const { config } = context
  const owner = portOwner(config.webPort)
  if (owner !== undefined) {
    if (context.json) process.stdout.write(`${JSON.stringify({ ok: true, running: true, pid: owner })}\n`)
    else process.stdout.write(`already running on ${config.webPort} (pid ${owner})\n`)
    return 0
  }
  if (!(await portFree(config.webPort))) {
    const message = unidentifiedListener(config.webPort)
    if (context.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message, nextAction: 'human' })}\n`)
    else process.stderr.write(`dsh-upgrade start: ${message}\n`)
    return 3
  }
  const active = activeSlot(config)
  if (active === undefined) {
    process.stderr.write('dsh-upgrade start: the stable path is not a slot link (run "init" and "apply")\n')
    return 4
  }
  try {
    const started = startService(config, slotPath(config, active))
    const ready = await waitForService(config, started.logPath, started.pid)
    if (context.json) process.stdout.write(`${JSON.stringify({ ok: ready, running: ready, pid: started.pid ?? null })}\n`)
    if (!ready) {
      process.stderr.write(`dsh-upgrade start: no answer on ${config.webPort} (see ${started.logPath})\n`)
      return 4
    }
    if (!context.json) process.stdout.write(`started on ${config.webPort}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`dsh-upgrade start: ${(error as Error).message}\n`)
    return 4
  }
}

/**
 * Stop whatever serves the web port.
 * @param options - global options.
 * @returns the exit code.
 */
export async function runStop(options: RunOptions): Promise<number> {
  const context = contextOf(options)
  if (context === undefined) return 4
  const { config } = context
  const owner = portOwner(config.webPort)
  if (owner === undefined) {
    // "No owner" is not "nothing is running": /proc can see a socket whose owner this account
    // cannot read. Ask the port itself before reporting that there was nothing to stop.
    if (await portFree(config.webPort)) {
      if (context.json) process.stdout.write(`${JSON.stringify({ ok: true, running: false })}\n`)
      else process.stdout.write(`not running on ${config.webPort}\n`)
      return 0
    }
    const message = unidentifiedListener(config.webPort)
    if (context.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message, nextAction: 'human' })}\n`)
    else process.stderr.write(`dsh-upgrade stop: ${message}\n`)
    return 3
  }
  stopService(config.webPort)
  // taskkill succeeding is not the same as the port being free: protection software can keep
  // the process alive, and reporting success there would be a lie.
  const freed = await waitPortFree(config.webPort)
  if (!freed) {
    process.stderr.write(`dsh-upgrade stop: pid ${owner} still holds ${config.webPort}` + "\n")
    return 4
  }
  if (context.json) process.stdout.write(`${JSON.stringify({ ok: true, running: false, stopped: owner })}\n`)
  else process.stdout.write(`stopped pid ${owner}\n`)
  return 0
}

/**
 * Start when stopped, stop when running.
 * @param args - `--yes` to stop without asking.
 * @param options - global options.
 * @returns the exit code.
 */
export async function runToggle(args: readonly string[], options: RunOptions): Promise<number> {
  let yes = false
  for (const argument of args) {
    if (argument === '--yes' || argument === '-y') { yes = true; continue }
    process.stderr.write(`dsh-upgrade toggle: unknown argument "${argument}"\n`)
    return 2
  }
  const context = contextOf(options)
  if (context === undefined) return 4
  const port = context.config.webPort
  const owner = portOwner(port)
  if (owner === undefined) {
    if (!(await portFree(port))) {
      const message = unidentifiedListener(port)
      process.stderr.write(`dsh-upgrade toggle: ${message}\n`)
      return 3
    }
    // Starting is not destructive, so only a launcher (no terminal, a desktop present) is asked;
    // a terminal start stays one keystroke.
    if (!yes && process.stdin.isTTY !== true && hasDisplay()) {
      const start = guiQuestion(`Start DeepSeek Harness on port ${port}?`)
      if (start === undefined) return noDialog(options)
      if (!start) {
        process.stdout.write('kept stopped\n')
        return 0
      }
    }
    return runStart([], options)
  }
  if (!yes) {
    if (process.stdin.isTTY === true) {
      process.stdout.write(`DeepSeek Harness is running on ${port}. Stop it? [y/N] `)
      // A shortcut has nobody at the keyboard: give the answer a deadline and treat silence as "keep".
      const answer = await Promise.race([
        new Promise<string>(resolve => {
          process.stdin.once('data', chunk => resolve(String(chunk).trim().toLowerCase()))
        }),
        new Promise<string>(resolve => { setTimeout(() => resolve(''), 20_000) }),
      ])
      if (answer !== 'y' && answer !== 'yes') {
        process.stdout.write('kept running\n')
        return 0
      }
    } else {
      if (!hasDisplay()) return noDialog(options)
      const stop = guiQuestion(`Stop DeepSeek Harness on port ${port}?`)
      if (stop === undefined) return noDialog(options)
      if (!stop) {
        process.stdout.write('kept running\n')
        return 0
      }
    }
  }
  const stopped = await runStop(options)
  if (stopped !== 0) return stopped
  await waitPortFree(port)
  return 0
}

/** One desktop launcher: what it is called, what it runs, and whether it waits. */
export interface Launcher {
  /** File name stem of the `.cmd`/`.vbs`/`.lnk` (Windows) or the `.desktop` entry (POSIX). */
  readonly name: string
  /** Label shown in the application menu, when the platform has one. */
  readonly title?: string
  /** CLI arguments the launcher passes. */
  readonly command: string
  /** Icon name (POSIX `.desktop`), installed beside the entry. */
  readonly icon?: string
  /** `false` for a program that outlives its launcher, like the tray. */
  readonly wait: boolean
}

/** The launchers `shortcuts` installs. */
export const LAUNCHERS: readonly Launcher[] = [
  { name: 'dsh-upgrade-start', title: 'DeepSeek Harness: start or stop', command: 'toggle --yes', wait: true },
  { name: 'dsh-upgrade-update', title: 'DeepSeek Harness: update', command: 'apply --wait', wait: true },
  { name: 'dsh-upgrade-tray', title: 'DeepSeek Harness: tray', command: 'tray', wait: false },
]

/**
 * The launchers POSIX installs.
 *
 * There is no tray companion outside Windows, so the entry that would start one is left out
 * rather than installed broken. `toggle` runs without `--yes` on purpose: a launcher has no
 * terminal, and the command asks in a desktop dialog before it starts or stops anything.
 */
export const POSIX_LAUNCHERS: readonly Launcher[] = [
  { name: 'dsh-upgrade-start', title: 'DeepSeek Harness: start or stop', command: 'toggle', icon: 'dsh-upgrade-start', wait: true },
  { name: 'dsh-upgrade-update', title: 'DeepSeek Harness: update', command: 'apply --wait', icon: 'dsh-upgrade-update', wait: true },
]

/** The two wrapper files of one launcher. */
export interface LauncherFiles {
  /** Batch wrapper, for running from a console. */
  readonly cmd: string
  /** Hidden `wscript` wrapper, for the desktop shortcut. */
  readonly vbs: string
}

/**
 * Render one launcher's wrappers.
 *
 * The `.vbs` is UTF-16LE with a BOM because `wscript` reads that as Unicode, so a path with
 * non-ASCII characters (Chinese user names, OneDrive folders) survives. The `.cmd` is a
 * trampoline: it must stay ASCII for `cmd.exe`, so it embeds no path and asks `wscript` to run
 * the sibling `.vbs` through `%~dp0`.
 * @param launcher - which launcher.
 * @param bin - directory the wrapper runs from.
 * @param cli - absolute path of the CLI entry.
 * @param node - absolute path of the node executable.
 */
export function launcherFiles(launcher: Launcher, bin: string, cli: string, node: string): LauncherFiles {
  return {
    cmd: `@echo off\r\nwscript.exe //nologo "%~dp0${launcher.name}.vbs"\r\n`,
    vbs: `\uFEFF${[
      "' Runs the launcher with no console window.",
      'Set sh = CreateObject("WScript.Shell")',
      `sh.CurrentDirectory = "${bin}"`,
      `sh.Run """${node}"" ""${cli}"" ${launcher.command}", 0, ${launcher.wait ? 'True' : 'False'}`,
      '',
    ].join('\r\n')}`,
  }
}

/**
 * Quote one `.desktop` `Exec` argument.
 *
 * `Exec` is not a shell, but it does treat backslash, double quote, backtick, and dollar as
 * escapes inside its own double quotes.
 * @param value - one argument.
 * @returns the quoted argument.
 */
function quoteExec(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`').replaceAll('$', '\\$').replaceAll('%', '%%')}"`
}

/**
 * Escape one `.desktop` string value.
 *
 * A string value (not `Exec`) uses backslash escapes, and a literal backslash must be doubled;
 * `%` is literal here, so only `Exec` doubles it.
 * @param value - the raw value.
 * @returns the value as the file must carry it.
 */
function desktopValue(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '')
    .replaceAll('\t', '\\t')
}

/**
 * Render one launcher as a `.desktop` entry.
 * @param launcher - which launcher.
 * @param cli - absolute path of the CLI entry.
 * @param node - absolute path of the node executable.
 * @param workingDirectory - directory the command runs in.
 * @returns the file's text.
 */
export function desktopEntry(launcher: Launcher, cli: string, node: string, workingDirectory: string): string {
  const command = [node, cli, ...launcher.command.split(' ')].map(quoteExec).join(' ')
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${desktopValue(launcher.title ?? launcher.name)}`,
    `Comment=${desktopValue(`Run: dsh-upgrade ${launcher.command}`)}`,
    `Icon=${launcher.icon ?? launcher.name}`,
    `Exec=${command}`,
    `Path=${desktopValue(workingDirectory)}`,
    'Terminal=false',
    'Categories=Utility;',
    '',
  ].join('\n')
}

/**
 * The desktop launchers, as hidden wrappers plus shortcuts.
 * @param args - `--install` or `--remove`.
 * @param options - global options.
 * @returns the exit code.
 */
export function runShortcuts(args: readonly string[], options: RunOptions): number {
  const install = args.includes('--install') || args.length === 0
  const remove = args.includes('--remove')
  if (!install && !remove) {
    process.stderr.write('dsh-upgrade shortcuts: pass --install or --remove\n')
    return 2
  }
  const context = contextOf(options)
  if (context === undefined) return 4
  return IS_WINDOWS
    ? windowsShortcuts(context.config, remove, options)
    : posixShortcuts(context.config, remove, options)
}

/**
 * Install or remove the Windows launchers: a `.cmd` trampoline, a `.vbs` wrapper, and a `.lnk`.
 * @param config - resolved tool configuration.
 * @param remove - `true` to remove instead of install.
 * @param options - global options.
 * @returns the exit code.
 */
function windowsShortcuts(config: Config, remove: boolean, options: RunOptions): number {
  const bin = join(config.root, 'bin')
  mkdirSync(bin, { recursive: true })
  const desktop = shortcutDirectory()

  if (remove) {
    for (const launcher of LAUNCHERS) {
      rmSync(join(bin, `${launcher.name}.cmd`), { force: true })
      rmSync(join(bin, `${launcher.name}.vbs`), { force: true })
      rmSync(join(desktop, `${launcher.name}.lnk`), { force: true })
    }
    rmSync(join(bin, 'create-shortcuts.ps1'), { force: true })
    process.stdout.write('removed launchers\n')
    return 0
  }

  const cli = cliEntryPath()
  const node = process.execPath
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$shell = New-Object -ComObject WScript.Shell',
  ]
  for (const launcher of LAUNCHERS) {
    const files = launcherFiles(launcher, bin, cli, node)
    writeFileSync(join(bin, `${launcher.name}.cmd`), files.cmd, 'ascii')
    writeFileSync(join(bin, `${launcher.name}.vbs`), files.vbs, 'utf16le')
    const link = join(desktop, `${launcher.name}.lnk`)
    script.push(`$s = $shell.CreateShortcut("${link}")`)
    script.push('$s.TargetPath = "C:\\Windows\\System32\\wscript.exe"')
    script.push(`$s.Arguments = """${join(bin, `${launcher.name}.vbs`)}"""`)
    script.push(`$s.WorkingDirectory = "${bin}"`)
    script.push('$s.Save()')
  }
  const scriptPath = join(bin, 'create-shortcuts.ps1')
  writeFileSync(scriptPath, `${script.join('\n')}\n`, 'utf8')
  const created = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { encoding: 'utf8' })
  if (created.status !== 0) {
    process.stderr.write(`dsh-upgrade shortcuts: could not create shortcuts: ${created.stderr}\n`)
    return 4
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, launchers: LAUNCHERS.map(launcher => join(desktop, `${launcher.name}.lnk`)) })}\n`)
    return 0
  }
  process.stdout.write([
    'created launchers:',
    ...LAUNCHERS.map(launcher => `  ${join(desktop, `${launcher.name}.lnk`)}`),
  ].join('\n') + '\n')
  return 0
}

/**
 * Install or remove the POSIX launchers: one `.desktop` entry per command, in the application
 * menu. There is no tray entry because there is no tray.
 * @param config - resolved tool configuration.
 * @param remove - `true` to remove instead of install.
 * @param options - global options.
 * @returns the exit code.
 */
function posixShortcuts(config: Config, remove: boolean, options: RunOptions): number {
  const directory = shortcutDirectory()
  const icons = iconDirectory()
  if (remove) {
    const existed = LAUNCHERS.some(launcher => existsSync(join(directory, `${launcher.name}.desktop`)))
    for (const launcher of LAUNCHERS) {
      rmSync(join(directory, `${launcher.name}.desktop`), { force: true })
      rmSync(join(icons, `${launcher.name}.svg`), { force: true })
    }
    if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, removed: existed })}\n`)
    else process.stdout.write('removed launchers\n')
    return 0
  }
  mkdirSync(directory, { recursive: true })
  const written: string[] = []
  for (const launcher of POSIX_LAUNCHERS) {
    const asset = join(options.toolRoot, 'assets', `${launcher.name}.svg`)
    if (existsSync(asset)) {
      mkdirSync(icons, { recursive: true })
      cpSync(asset, join(icons, `${launcher.name}.svg`))
    }
    const path = join(directory, `${launcher.name}.desktop`)
    writeFileSync(path, desktopEntry(launcher, cliEntryPath(), process.execPath, config.root), 'utf8')
    written.push(path)
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, launchers: written })}\n`)
    return 0
  }
  process.stdout.write([
    'created launchers:',
    ...written.map(path => `  ${path}`),
    '  they appear in the application menu with their icons; no panel icon is installed',
  ].join('\n') + '\n')
  return 0
}




