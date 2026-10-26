/**
 * `tray`: run the tray companion.
 *
 * The companion itself is a PowerShell 7 script (`engine-ps/tray.ps1`) because that is the
 * only Windows GUI toolkit the tool already depends on. This command resolves the paths the
 * script must not guess — the tool root, the CLI entry, the configuration file, node — and
 * then hands the terminal (or the launcher's hidden window) to it until the icon is closed.
 *
 * `--dry-run` prints exactly what would run. A tray that will not start is otherwise silent:
 * the window closes and nothing is left to read.
 *
 * @module dsh-upgrade/commands/tray
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { RunOptions } from '../cli.ts'
import { loadConfig, resolveConfigPath } from '../engine/config.ts'
import { cliEntryPath } from '../engine/entry.ts'

/** Companion script, relative to the tool root. Splitting it keeps forward slashes working. */
export const TRAY_SCRIPT = 'engine-ps/tray.ps1'

/** Absolute path of the companion script. */
function scriptPathOf(toolRoot: string): string {
  return join(toolRoot, ...TRAY_SCRIPT.split('/'))
}

/** The command line the companion is started with, once the paths are resolved. */
interface TrayLaunch {
  /** The PowerShell 7 executable. */
  readonly executable: string
  /** Arguments, including the script and every path it needs. */
  readonly args: readonly string[]
}

/**
 * Build the companion's command line.
 * @param toolRoot - the tool's own directory.
 * @param configPath - resolved configuration file.
 * @param node - the node executable the companion reuses.
 */
function launchOf(toolRoot: string, configPath: string, node: string): TrayLaunch {
  return {
    executable: 'pwsh',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPathOf(toolRoot),
      '-ToolRoot',
      toolRoot,
      '-Cli',
      cliEntryPath(),
      '-Config',
      configPath,
      '-Node',
      node,
    ],
  }
}

/**
 * Render a command line the way it can be pasted into a console.
 * @param launch - the resolved launch.
 */
function quote(launch: TrayLaunch): string {
  return [launch.executable, ...launch.args]
    .map(part => (part === '' || /[\s"]/.test(part) ? `"${part.replaceAll('"', '\\"')}"` : part))
    .join(' ')
}

/**
 * Run `tray`.
 * @param args - `--dry-run` prints the command instead of running it.
 * @param options - global options.
 * @returns `0` when the companion exits, `2`/`4` when it cannot start.
 */
export function runTray(args: readonly string[], options: RunOptions): number {
  const dryRun = args.includes('--dry-run')
  for (const argument of args) {
    if (argument !== '--dry-run') {
      process.stderr.write(`dsh-upgrade tray: unknown argument "${argument}"\n`)
      return 2
    }
  }

  const configPath = resolveConfigPath(options.configPath, options.cwd, options.toolRoot)
  if (!existsSync(configPath)) {
    process.stderr.write(`dsh-upgrade tray: ${configPath} not found (run "dsh-upgrade init")\n`)
    return 4
  }
  try {
    loadConfig(configPath)
  } catch (error) {
    process.stderr.write(`dsh-upgrade tray: ${(error as Error).message}\n`)
    return 4
  }

  const script = scriptPathOf(options.toolRoot)
  if (!existsSync(script)) {
    process.stderr.write(`dsh-upgrade tray: the companion is missing at ${script}; reinstall the tool\n`)
    return 4
  }
  const launch = launchOf(options.toolRoot, configPath, process.execPath)
  const version = spawnSync(launch.executable, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' })
  const major = Number.parseInt((version.stdout ?? '').trim(), 10)
  if (version.error !== undefined || !(major >= 7)) {
    process.stderr.write('dsh-upgrade tray: PowerShell 7 (pwsh) is required (winget install Microsoft.PowerShell)\n')
    return 4
  }

  if (dryRun) {
    const command = quote(launch)
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, script, cli: cliEntryPath(), config: configPath, command, args: launch.args })}\n`)
    } else {
      process.stdout.write(`${command}\n`)
    }
    return 0
  }

  const started = spawnSync(launch.executable, [...launch.args], { stdio: 'inherit' })
  if (started.error !== undefined) {
    process.stderr.write(`dsh-upgrade tray: could not start the companion: ${started.error.message}\n`)
    return 4
  }
  return started.status ?? 0
}
