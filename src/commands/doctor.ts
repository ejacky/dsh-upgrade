/**
 * `doctor`: probe the machine and say what would break an upgrade.
 *
 * Every probe is cheap, read-only, and reports a concrete next action. `--fix` applies the
 * one repair that is a pure configuration choice: `manualBuild` for machines whose protection
 * software refuses a child process the right to delete a large temporary file.
 *
 * The probe list itself is a platform contract: PowerShell, long paths, and the protection
 * driver exist on Windows; the systemd user session exists elsewhere. A probe that cannot be
 * meaningful on this machine is not reported as a failure.
 *
 * @module dsh-upgrade/commands/doctor
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, resolveConfigPath, type Config } from '../engine/config.ts'
import { IS_WINDOWS, portFree, portOwner } from '../engine/host.ts'
import { describeLink } from '../engine/link.ts'
import { pnpmInvocation } from '../engine/pnpm.ts'
import { activeSlot, slotPath } from '../engine/slots.ts'
import type { RunOptions } from '../cli.ts'

/** One probe result. */
interface Probe {
  /** Stable identifier for scripts. */
  readonly id: string
  /** Whether the machine satisfies it. */
  readonly ok: boolean
  /** What was observed. */
  readonly detail: string
  /** What to do when it is not satisfied. */
  readonly nextAction?: string
  /** Whether a failure blocks an upgrade outright. */
  readonly blocking?: boolean
}

/**
 * Run a command and return its exit status and combined output.
 * @param file - executable.
 * @param args - arguments.
 */
function probeCommand(file: string, args: readonly string[]): { ok: boolean, text: string } {
  // A probe must never hang `doctor`: a D-Bus or credential helper that waits forever would
  // make the command useless exactly when it is needed.
  const result = spawnSync(file, [...args], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error === undefined ? '' : result.error.message}`.trim()
  return { ok: result.status === 0, text }
}

/**
 * Whether this machine refuses to let a child process delete a large temporary file.
 *
 * The probe creates 1.2 MiB (above the observed 1 MiB threshold), then asks a child to remove
 * it. A refusal here is what breaks esbuild-driven builds on protected Windows machines.
 */
function protectionProbe(): Probe {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-upgrade-doctor-'))
  const file = join(directory, 'large.tmp')
  writeFileSync(file, Buffer.alloc(1_200_000))
  const deleted = spawnSync(process.execPath, ['-e', 'require("node:fs").unlinkSync(process.argv[1])', file], { encoding: 'utf8' })
  const size = existsSync(file) ? statSync(file).size : 0
  rmSync(directory, { recursive: true, force: true })
  if (deleted.status === 0) return { id: 'protection-driver', ok: true, detail: 'a child can delete a 1.2 MB temporary file' }
  return {
    id: 'protection-driver',
    ok: false,
    detail: `a child could not delete a 1.2 MB temporary file (${size} bytes left); builds need an administrator console`,
    nextAction: 'run "dsh-upgrade doctor --fix" to set manualBuild, then build from an elevated console',
  }
}

/**
 * Collect every probe.
 * @param options - global options.
 */
async function probesOf(options: RunOptions): Promise<{
  probes: Probe[]
  configPath: string
  config: ReturnType<typeof loadConfig> | undefined
}> {
  const configPath = resolveConfigPath(options.configPath, options.cwd, options.toolRoot)
  const config = existsSync(configPath) ? loadConfig(configPath) : undefined
  const probes: Probe[] = []
  probes.push({
    id: 'config',
    ok: config !== undefined,
    detail: config !== undefined ? `configuration at ${configPath}` : `no configuration at ${configPath}`,
    nextAction: 'run "dsh-upgrade init"',
    blocking: true,
  })

  if (IS_WINDOWS) {
    const pwsh = probeCommand('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'])
    probes.push({
      id: 'powershell-7',
      ok: pwsh.ok && Number.parseInt(pwsh.text, 10) >= 7,
      detail: pwsh.ok ? `pwsh reports ${pwsh.text}` : 'pwsh not found',
      nextAction: 'install PowerShell 7 (winget install Microsoft.PowerShell)',
      blocking: true,
    })
  }
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
  probes.push({
    id: 'node-24',
    ok: major >= 24,
    detail: `node ${process.versions.node}`,
    nextAction: 'use Node.js 24 or newer',
    blocking: true,
  })
  const git = probeCommand('git', ['--version'])
  probes.push({
    id: 'git',
    ok: git.ok,
    detail: git.ok ? git.text : 'git not found',
    nextAction: IS_WINDOWS ? 'install git for Windows' : 'install git',
    blocking: true,
  })

  const pnpm = pnpmInvocation()
  const pnpmVersion = probeCommand(pnpm.file, [...pnpm.prefixArgs, '--version'])
  probes.push({ id: 'pnpm', ok: pnpmVersion.ok, detail: pnpmVersion.ok ? `pnpm ${pnpmVersion.text}` : 'pnpm not runnable', nextAction: 'enable corepack or install pnpm', blocking: true })

  if (!IS_WINDOWS) {
    // Only the watcher needs this; an upgrade works without it.
    const user = probeCommand('systemctl', ['--user', 'show-environment'])
    probes.push({
      id: 'systemd-user',
      ok: user.ok,
      detail: user.ok ? 'a systemd user session answers' : 'systemctl --user does not answer',
      nextAction: 'install systemd and log in normally; without it only "task install" is unavailable',
    })
  }

  if (IS_WINDOWS) {
    const longPaths = probeCommand('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem', '/v', 'LongPathsEnabled'])
    const enabled = /LongPathsEnabled\s+REG_DWORD\s+0x1/.test(longPaths.text)
    probes.push({
      id: 'long-paths',
      ok: enabled,
      detail: enabled ? 'LongPathsEnabled=1' : 'LongPathsEnabled is not 1',
      nextAction: 'enable LongPathsEnabled (admin) and run git config --global core.longpaths true',
    })
  }

  if (config !== undefined) {
    for (const [id, port] of [['web-port', config.webPort], ['smoke-port', config.smokePort]] as const) {
      const owner = portOwner(port)
      const free = owner === undefined && await portFree(port)
      probes.push({
        id,
        ok: free || id === 'web-port',
        detail: free
          ? `${port} is free`
          : owner === undefined
            ? `${port} is in use by a process this account cannot identify`
            : `${port} is held by pid ${owner}`,
        ...free ? {} : { nextAction: `change ${id} in the configuration or stop pid ${owner ?? 'that process'}` },
      })
    }
    const free = spawnSync(process.execPath, ['-e', "const s=require('node:fs').statfsSync(process.argv[1]);process.stdout.write(String(Math.round(s.bavail*s.bsize/1e9)))", config.root], { encoding: 'utf8' })
    const gigabytes = Number.parseInt(free.stdout ?? '0', 10)
    probes.push({ id: 'disk', ok: gigabytes >= 10, detail: `${gigabytes} GB free at ${config.root}`, nextAction: 'free at least 10 GB for two slots', blocking: false })
    if (IS_WINDOWS) probes.push(protectionProbe())
    const link = describeLink(config.stablePath)
    probes.push({
      id: 'stable-path',
      ok: link.kind !== 'directory',
      detail: link.kind === 'absent' ? 'stable path not created yet (run "stage" then "apply")'
        : link.kind === 'link' ? `link to ${link.target}`
        : 'stable path is a real directory',
      ...link.kind === 'directory' ? { nextAction: 'move the hand-made checkout aside; the tool only replaces a link' } : {},
    })
    const active = activeSlot(config)
    if (active !== undefined) {
      const writable = spawnSync(process.execPath, ['-e', 'const fs=require("node:fs"),p=require("node:path");fs.writeFileSync(p.join(process.argv[1],"__probe"),"x");fs.unlinkSync(p.join(process.argv[1],"__probe"))', slotPath(config, active)], { encoding: 'utf8' })
      probes.push({
        id: 'slot-writable',
        ok: writable.status === 0,
        detail: writable.status === 0 ? `slot ${active} is writable` : `slot ${active} is not writable`,
        nextAction: 'grant this account full control on the slot directory',
      })
    }
    probes.push(providerHeaderProbe(config))
  }
  return { probes, configPath, config }
}

/**
 * Whether a pi-ai build carries the OpenCode session header.
 * @param file - path to `dist/providers/opencode-headers.js`.
 * @returns `true` when the file exists and mentions the header it adds.
 */
function providesHeader(file: string): boolean {
  if (!existsSync(file)) return false
  try {
    return readFileSync(file, 'utf8').includes('x-opencode-session')
  } catch {
    return false
  }
}

/**
 * Whether the installed harness sends the gateway's session header itself.
 *
 * pi-ai 1.3.0 wraps its opencode providers with `withOpenCodeSessionHeader`, which adds
 * `x-opencode-session` from the harness session id. Older checkouts do not, and no tool-side
 * patch can repair that: the answer is a newer release. The probe resolves the package the
 * harness actually loads (the workspace link, then a hoisted copy, then the pnpm store) instead
 * of trusting a version number, because a local patch can change either one.
 * @param config - resolved tool configuration.
 */
function providerHeaderProbe(config: Config): Probe {
  const relative = join('dist', 'providers', 'opencode-headers.js')
  const resolved = join(config.stablePath, 'packages', 'llm', 'llm-pi-ai', 'node_modules', '@earendil-works', 'pi-ai', relative)
  if (existsSync(resolved)) {
    return providesHeader(resolved)
      ? { id: 'provider-session-header', ok: true, detail: 'pi-ai sends x-opencode-session natively (workspace link)' }
      : {
        id: 'provider-session-header',
        ok: false,
        detail: `the pi-ai build at ${resolved} does not add x-opencode-session`,
        nextAction: 'stage and apply a newer harness release; an older pi-ai cannot talk to the gateway',
      }
  }
  const modules = join(config.stablePath, 'node_modules')
  if (!existsSync(modules)) {
    return {
      id: 'provider-session-header',
      ok: true,
      detail: 'no built harness under the stable path yet; this probe reports after "apply"',
    }
  }
  const hoisted = join(modules, '@earendil-works', 'pi-ai', relative)
  if (existsSync(hoisted)) {
    return providesHeader(hoisted)
      ? { id: 'provider-session-header', ok: true, detail: 'pi-ai sends x-opencode-session natively (hoisted install)' }
      : {
        id: 'provider-session-header',
        ok: false,
        detail: `the pi-ai build at ${hoisted} does not add x-opencode-session`,
        nextAction: 'stage and apply a newer harness release; an older pi-ai cannot talk to the gateway',
      }
  }
  const store = join(modules, '.pnpm')
  let entries: string[]
  try {
    entries = readdirSync(store)
  } catch (error) {
    // Not the same as "not installed": the store may be missing (an npm layout) or unreadable.
    return {
      id: 'provider-session-header',
      ok: false,
      detail: `cannot read the package store at ${store} (${(error as Error).message})`,
      nextAction: 'check permissions on the stable path, or re-run "stage" and "apply"',
    }
  }
  const packages = entries.filter(entry => entry.startsWith('@earendil-works+pi-ai@'))
  if (packages.length === 0) {
    return {
      id: 'provider-session-header',
      ok: false,
      detail: `pi-ai is not installed under ${config.stablePath}`,
      nextAction: 'run "dsh-upgrade stage" and "apply"',
    }
  }
  const version = packages.find(entry => providesHeader(join(store, entry, 'node_modules', '@earendil-works', 'pi-ai', relative)))
  return version === undefined
    ? {
      id: 'provider-session-header',
      ok: false,
      detail: `no pi-ai build under ${config.stablePath} adds x-opencode-session`,
      nextAction: 'stage and apply a newer harness release; an older pi-ai cannot talk to the gateway',
    }
    : { id: 'provider-session-header', ok: true, detail: 'pi-ai sends x-opencode-session natively (pnpm store)' }
}

/**
 * Run `doctor`.
 * @param args - `--fix` applies the configuration repair.
 * @param options - global options.
 * @returns `0` when nothing blocking failed, `4` otherwise.
 */
export async function runDoctor(args: readonly string[], options: RunOptions): Promise<number> {
  const fix = args.includes('--fix')
  const { probes, configPath, config } = await probesOf(options)
  const fixed: string[] = []

  if (fix && config !== undefined) {
    const protection = probes.find(probe => probe.id === 'protection-driver')
    if (protection !== undefined && !protection.ok && !config.manualBuild) {
      // Patch only this key: rewriting the parsed config would drop fields this build does not know.
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
      raw['manualBuild'] = true
      writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
      fixed.push('manualBuild')
      process.stdout.write('set manualBuild: true — build from an administrator console\n')
    } else if (protection === undefined && !options.json) {
      // Silence here would read as "fixed something"; the flag exists only for the Windows probe.
      process.stdout.write('nothing to fix on this platform (manualBuild is Windows-only)\n')
    }
  }

  const blocking = probes.filter(probe => probe.blocking === true && !probe.ok)
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: blocking.length === 0, blocking: blocking.map(probe => probe.id), probes, ...fix ? { fixed } : {} })}\n`)
  } else {
    process.stdout.write('dsh-upgrade doctor\n')
    for (const probe of probes) {
      const mark = probe.ok ? 'ok  ' : probe.blocking === true ? 'FAIL' : 'warn'
      process.stdout.write(`  ${mark} ${probe.id.padEnd(20)} ${probe.detail}\n`)
      if (!probe.ok && probe.nextAction !== undefined) process.stdout.write(`       → ${probe.nextAction}\n`)
    }
  }
  return blocking.length === 0 ? 0 : 4
}
