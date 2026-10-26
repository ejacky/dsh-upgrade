/**
 * `doctor`: probe the machine and say what would break an upgrade.
 *
 * Every probe is cheap, read-only, and reports a concrete next action. `--fix` applies the
 * one repair that is a pure configuration choice: `manualBuild` for machines whose protection
 * software refuses a child process the right to delete a large temporary file.
 *
 * @module dsh-upgrade/commands/doctor
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, resolveConfigPath } from '../engine/config.ts'
import { describeLink } from '../engine/link.ts'
import { pnpmInvocation } from '../engine/pnpm.ts'
import { profileDirOf, profileStateOf } from '../engine/profile.ts'
import { portOwner } from '../engine/service.ts'
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
  const result = spawnSync(file, [...args], { encoding: 'utf8', windowsHide: true })
  return { ok: result.status === 0, text: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

/**
 * Whether this machine refuses to let a child process delete a large temporary file.
 *
 * The probe creates 1.2 MiB (above the observed 1 MiB threshold), then asks a child to remove
 * it. A refusal here is what breaks esbuild-driven builds on protected machines.
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
function probesOf(options: RunOptions): { probes: Probe[], configPath: string, config: ReturnType<typeof loadConfig> | undefined } {
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

  const pwsh = probeCommand('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'])
  probes.push({
    id: 'powershell-7',
    ok: pwsh.ok && Number.parseInt(pwsh.text, 10) >= 7,
    detail: pwsh.ok ? `pwsh reports ${pwsh.text}` : 'pwsh not found',
    nextAction: 'install PowerShell 7 (winget install Microsoft.PowerShell)',
    blocking: true,
  })
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
  probes.push({
    id: 'node-24',
    ok: major >= 24,
    detail: `node ${process.versions.node}`,
    nextAction: 'use Node.js 24 or newer',
    blocking: true,
  })
  const git = probeCommand('git', ['--version'])
  probes.push({ id: 'git', ok: git.ok, detail: git.ok ? git.text : 'git not found', nextAction: 'install git for Windows', blocking: true })

  const pnpm = pnpmInvocation()
  const pnpmVersion = probeCommand(pnpm.file, [...pnpm.prefixArgs, '--version'])
  probes.push({ id: 'pnpm', ok: pnpmVersion.ok, detail: pnpmVersion.ok ? `pnpm ${pnpmVersion.text}` : 'pnpm not runnable', nextAction: 'enable corepack or install pnpm', blocking: true })

  if (process.platform === 'win32') {
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
      probes.push({
        id,
        ok: owner === undefined || id === 'web-port',
        detail: owner === undefined ? `${port} is free` : `${port} is held by pid ${owner}`,
        ...owner === undefined ? {} : { nextAction: `change ${id} in the configuration or stop pid ${owner}` },
      })
    }
    const free = spawnSync(process.execPath, ['-e', "const s=require('node:fs').statfsSync(process.argv[1]);process.stdout.write(String(Math.round(s.bavail*s.bsize/1e9)))", config.root], { encoding: 'utf8' })
    const gigabytes = Number.parseInt(free.stdout ?? '0', 10)
    probes.push({ id: 'disk', ok: gigabytes >= 10, detail: `${gigabytes} GB free at ${config.root}`, nextAction: 'free at least 10 GB for two slots', blocking: false })
    probes.push(protectionProbe())
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
    probes.push(sessionProbe(config))
  }
  return { probes, configPath, config }
}

/**
 * Whether the profile carries the gateway header, and by which mechanism.
 *
 * A provider `sessionHeader` in the profile patch and the bundled plugin do the same job. Two
 * mechanisms are not two safety nets: they are two places to forget. The probe accepts either
 * and says which one it found.
 * @param config - resolved tool configuration.
 */
function sessionProbe(config: ReturnType<typeof loadConfig>): Probe {
  const directory = profileDirOf(config)
  const state = profileStateOf(directory)
  const legacy = state.sessionHeader.length > 0
  if (!config.opencodeSession.enabled) {
    return {
      id: 'opencode-session',
      ok: true,
      detail: 'disabled in the configuration; requests carry no gateway session header',
    }
  }
  if (state.version !== undefined && state.bundle && !legacy) {
    return {
      id: 'opencode-session',
      ok: true,
      detail: `${state.version} in profile ${config.profile}${state.override ? ` (${config.opencodeSession.header} on ${config.opencodeSession.urlMarkers.join(', ')})` : ' (defaults)'}`,
    }
  }
  if (state.version !== undefined && !state.bundle) {
    // Installed as a plain dependency: its `cordis.patch.yml` row is never loaded, so the header
    // is not sent even though the package is present.
    return {
      id: 'opencode-session',
      ok: false,
      detail: `${state.version} is installed in profile ${config.profile} but is not a profile layer; its row never loads`,
      nextAction: 'run "dsh-upgrade opencode-session install" again, which records the layer through dsh plugin add',
    }
  }
  if (legacy && state.version === undefined) {
    return {
      id: 'opencode-session',
      ok: true,
      detail: 'the profile patches the header through a provider sessionHeader (works, but does not survive an upstream change)',
      nextAction: 'run "dsh-upgrade opencode-session install" to move it to the plugin',
    }
  }
  return {
    id: 'opencode-session',
    ok: false,
    detail: state.version === undefined
      ? `not installed in profile ${config.profile}; the gateway session header is missing`
      : `${state.version} is installed, but the profile still sets a provider sessionHeader`,
    nextAction: 'run "dsh-upgrade opencode-session install"',
  }
}

/**
 * Run `doctor`.
 * @param args - `--fix` applies the configuration repair.
 * @param options - global options.
 * @returns `0` when nothing blocking failed, `4` otherwise.
 */
export function runDoctor(args: readonly string[], options: RunOptions): number {
  const fix = args.includes('--fix')
  const { probes, configPath, config } = probesOf(options)

  if (fix && config !== undefined) {
    const protection = probes.find(probe => probe.id === 'protection-driver')
    if (protection !== undefined && !protection.ok && !config.manualBuild) {
      // Patch only this key: rewriting the parsed config would drop fields this build does not know.
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
      raw['manualBuild'] = true
      writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
      process.stdout.write('set manualBuild: true — build from an administrator console\n')
    }
  }

  const blocking = probes.filter(probe => probe.blocking === true && !probe.ok)
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: blocking.length === 0, blocking: blocking.map(probe => probe.id), probes })}\n`)
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

