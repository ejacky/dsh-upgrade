/**
 * `toggle` / `start` / `stop`: the one-icon control of the serving web app.
 *
 * The tray and the desktop shortcut both call `toggle`, which starts the server when the port
 * is free and otherwise stops it. Stopping is destructive enough that it needs consent:
 * `--yes` (the tray asks in its own dialog) or an interactive terminal.
 *
 * @module dsh-upgrade/commands/power
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, resolveConfigPath } from '../engine/config.ts'
import { cliEntryPath } from '../engine/entry.ts'
import { portOwner, startService, stopService, waitForService } from '../engine/service.ts'
import { activeSlot, slotPath } from '../engine/slots.ts'
import type { RunOptions } from '../cli.ts'

/**
 * Wait until a port is free.
 * @param port - the port.
 * @param timeoutMs - upper bound.
 * @returns whether the port became free.
 */
async function waitPortFree(port: number, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (portOwner(port) === undefined) return true
    await new Promise(resolve => { setTimeout(resolve, 300) })
  }
  return portOwner(port) === undefined
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
  const active = activeSlot(config)
  if (active === undefined) {
    process.stderr.write('dsh-upgrade start: the stable path is not a slot link (run "init" and "apply")\n')
    return 4
  }
  try {
    const started = startService(config, slotPath(config, active))
    const ready = await waitForService(config, started.logPath)
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
    if (context.json) process.stdout.write(`${JSON.stringify({ ok: true, running: false })}\n`)
    else process.stdout.write(`not running on ${config.webPort}\n`)
    return 0
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
  const owner = portOwner(context.config.webPort)
  if (owner === undefined) return runStart([], options)
  if (!yes && process.stdin.isTTY !== true) {
    process.stderr.write(`dsh-upgrade toggle: running on ${context.config.webPort}; pass --yes to stop it\n`)
    return 3
  }
  if (!yes) {
    process.stdout.write(`DeepSeek Harness is running on ${context.config.webPort}. Stop it? [y/N] `)
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
  }
  const stopped = await runStop(options)
  if (stopped !== 0) return stopped
  await waitPortFree(context.config.webPort)
  return 0
}

/** One desktop launcher: what it is called, what it runs, and whether it waits. */
export interface Launcher {
  /** File name stem of the `.cmd`/`.vbs`/`.lnk`. */
  readonly name: string
  /** CLI arguments the launcher passes. */
  readonly command: string
  /** `false` for a program that outlives its launcher, like the tray. */
  readonly wait: boolean
}

/** The launchers `shortcuts` installs. */
export const LAUNCHERS: readonly Launcher[] = [
  { name: 'dsh-upgrade-start', command: 'toggle --yes', wait: true },
  { name: 'dsh-upgrade-update', command: 'apply --wait', wait: true },
  { name: 'dsh-upgrade-tray', command: 'tray', wait: false },
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
 * non-ASCII characters (Chinese user names, OneDrive folders) survives; the `.cmd` stays
 * ASCII, because `cmd.exe` reads it in the console code page.
 * @param launcher - which launcher.
 * @param bin - directory the wrapper runs from.
 * @param cli - absolute path of the CLI entry.
 * @param node - absolute path of the node executable.
 */
export function launcherFiles(launcher: Launcher, bin: string, cli: string, node: string): LauncherFiles {
  return {
    cmd: `@echo off\r\n"${node}" "${cli}" ${launcher.command}\r\n`,
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
  const { config } = context
  const bin = join(config.root, 'bin')
  mkdirSync(bin, { recursive: true })
  const desktopProbe = spawnSync('pwsh', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"], { encoding: 'utf8' })
  const desktop = (desktopProbe.stdout ?? '').trim() !== '' ? (desktopProbe.stdout ?? '').trim() : join(process.env['USERPROFILE'] ?? '', 'Desktop')

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




