/**
 * `status`: what is serving, what is staged, and what went wrong last.
 *
 * Reads only; safe to run while an upgrade is in progress and safe to run from any session.
 *
 * @module dsh-upgrade/commands/status
 */
import { existsSync } from 'node:fs'
import { loadConfig, resolveConfigPath } from '../engine/config.ts'
import { readState, statePathOf } from '../engine/state.ts'
import { activeSlot, slotExists, slotPath, SLOT_NAMES, type SlotName } from '../engine/slots.ts'
import { tagAtHead } from '../engine/git.ts'
import type { RunOptions } from '../cli.ts'

/** One slot as reported. */
interface SlotReport {
  readonly name: SlotName
  readonly path: string
  readonly exists: boolean
  readonly tag: string | undefined
}

/**
 * Collect the slots' on-disk facts.
 * @param config - resolved tool configuration.
 */
function slotReports(config: Parameters<typeof activeSlot>[0]): SlotReport[] {
  return SLOT_NAMES.map(name => {
    const path = slotPath(config, name)
    const exists = slotExists(config, name)
    return { name, path, exists, tag: exists ? tagAtHead(path) : undefined }
  })
}

/**
 * Run `status`.
 * @param _args - `status` takes no arguments.
 * @param options - global options.
 * @returns the process exit code.
 */
export function runStatus(_args: readonly string[], options: RunOptions): number {
  const configPath = resolveConfigPath(options.configPath, options.cwd, options.toolRoot)
  if (!existsSync(configPath)) {
    process.stderr.write(`dsh-upgrade status: ${configPath} not found (run "dsh-upgrade init")\n`)
    return 4
  }
  const config = loadConfig(configPath)
  const state = readState(statePathOf(config))
  const active = activeSlot(config)
  const slots = slotReports(config)

  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      configPath,
      stablePath: config.stablePath,
      activeSlot: active ?? null,
      deployed: state.deployed,
      staged: state.staged,
      lastCheck: state.lastCheck,
      lastError: state.lastError,
      slots,
    })}\n`)
    return 0
  }

  const serving = active === undefined
    ? '(none — run "dsh-upgrade stage")'
    : `slot ${active}${slots.find(item => item.name === active)?.tag === undefined ? '' : ` at ${slots.find(item => item.name === active)?.tag}`}`
  const staged = state.staged === null
    ? 'none'
    : `${state.staged.tag} (slot ${state.staged.slot})`
  process.stdout.write([
    'dsh-upgrade status',
    `  config      ${configPath}`,
    `  stable path ${config.stablePath}`,
    `  serving     ${serving}`,
    `  staged      ${staged}`,
    `  last check  ${state.lastCheck ?? 'never'}`,
    `  last error  ${state.lastError ?? 'none'}`,
    '  slots:',
    ...slots.map(item => `    ${item.name}  ${item.exists ? `tag ${item.tag ?? '(detached)'}` : '(empty)'}  ${item.path}`),
  ].join('\n') + '\n')
  return 0
}
