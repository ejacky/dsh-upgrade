/**
 * pnpm invocation and the two long steps that use it.
 *
 * pnpm is reached through its JavaScript entry point rather than its `.cmd` shim: spawning a
 * script avoids shell quoting entirely, and the same call shape works when a caller points
 * `DSH_UPGRADE_PNPM_JS` at a different entry.
 *
 * @module dsh-upgrade/engine/pnpm
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Config } from './config.ts'
import { pnpmShim } from './host.ts'
import { runLogged, type ProcResult } from './proc.ts'
import { removeTree } from './tree.ts'
import type { Logger } from './worktree.ts'

/** Install and build budgets: generous enough for a cold monorepo, short enough to notice. */
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000
const BUILD_TIMEOUT_MS = 2 * 60 * 60 * 1000

/** How to start pnpm. */
export interface PnpmInvocation {
  /** Executable to spawn. */
  readonly file: string
  /** Arguments placed before the command word. */
  readonly prefixArgs: readonly string[]
}

/**
 * Resolve how to run pnpm.
 *
 * Order: the explicit override, corepack's JavaScript entry beside the running Node, then the
 * platform's `pnpm` shim through a shell (the least predictable case, kept last).
 */
export function pnpmInvocation(): PnpmInvocation {
  const override = process.env['DSH_UPGRADE_PNPM_JS']
  if (override !== undefined && override !== '') return { file: process.execPath, prefixArgs: [override] }
  const corepack = join(dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'pnpm.js')
  if (existsSync(corepack)) return { file: process.execPath, prefixArgs: [corepack] }
  // Windows only has the `.cmd` wrapper; POSIX installs a real executable, and spawning it
  // directly keeps quoting out of the picture.
  return { file: pnpmShim(), prefixArgs: [] }
}

/** Result of an install, including whether a stale layout had to be removed. */
export interface InstallResult extends ProcResult {
  /** `true` when pnpm asked to reinstall the modules directory and the tool obliged. */
  readonly purged: boolean
}

/**
 * Install dependencies in a slot.
 *
 * pnpm records absolute layout paths in `node_modules/.modules.yaml`. When a slot is moved or
 * was once installed through a different path, pnpm asks whether to remove and reinstall the
 * modules directory — a prompt that no unattended run can answer. The tool answers it by
 * deleting the directory itself (a delete never prompts) and retrying once.
 * @param config - resolved tool configuration.
 * @param slotDirectory - the slot to install into.
 * @param logPath - log file for this step.
 * @param logger - progress sink.
 */
export async function install(_config: Config, slotDirectory: string, logPath: string, logger: Logger): Promise<InstallResult> {
  const pnpm = pnpmInvocation()
  const invoke = (): Promise<ProcResult> => runLogged({
    file: pnpm.file,
    args: [...pnpm.prefixArgs, 'install', '--frozen-lockfile'],
    cwd: slotDirectory,
    logPath,
    timeoutMs: INSTALL_TIMEOUT_MS,
    env: { CI: '1' },
    ...pnpm.file.endsWith('.cmd') ? { shell: true } : {},
  })
  const first = await invoke()
  if (first.code === 0) return { ...first, purged: false }
  const asked = first.tail.some(line => /will be removed and reinstalled|ABORTED_REMOVE_MODULES_DIR/.test(line))
  if (!asked) return { ...first, purged: false }
  logger('pnpm reports a stale modules directory; removing it and reinstalling once')
  removeTree(join(slotDirectory, 'node_modules'), [slotDirectory])
  const second = await invoke()
  return { ...second, purged: true }
}

/**
 * Build a slot.
 * @param config - resolved tool configuration.
 * @param slotDirectory - the slot to build.
 * @param logPath - log file for this step.
 */
export async function build(config: Config, slotDirectory: string, logPath: string): Promise<ProcResult> {
  const pnpm = pnpmInvocation()
  return runLogged({
    file: pnpm.file,
    args: [...pnpm.prefixArgs, 'run', 'build'],
    cwd: slotDirectory,
    logPath,
    timeoutMs: BUILD_TIMEOUT_MS,
    env: { DSH_GATE_CONCURRENCY: String(config.buildGateConcurrency) },
    ...pnpm.file.endsWith('.cmd') ? { shell: true } : {},
  })
}

