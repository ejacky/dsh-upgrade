/**
 * Applying the configured source patches.
 *
 * Patches are the escape hatch for behaviour that has no configuration or plugin seam. A
 * patch that no longer applies must fail the stage loudly: staging a version with a
 * partially applied patch set would ship a tree nobody tested.
 *
 * @module dsh-upgrade/engine/patches
 */
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import type { Config } from './config.ts'
import { git } from './git.ts'
import type { Logger } from './worktree.ts'

/** Outcome of applying every configured patch. */
export interface PatchOutcome {
  /** Whether all patches applied. */
  readonly ok: boolean
  /** Paths that applied, as given in the configuration. */
  readonly applied: readonly string[]
  /** First failing patch and git's explanation. */
  readonly error?: string
}

/**
 * Apply `config.patchFiles` to a slot.
 * @param config - resolved tool configuration.
 * @param slotDirectory - the slot to patch.
 * @param toolRoot - directory that relative patch paths resolve against.
 * @param logger - progress sink.
 * @returns what applied and the first failure.
 */
export function applyPatches(config: Config, slotDirectory: string, toolRoot: string, logger: Logger): PatchOutcome {
  const applied: string[] = []
  for (const entry of config.patchFiles) {
    const path = isAbsolute(entry) ? entry : join(toolRoot, entry)
    if (!existsSync(path)) return { ok: false, applied, error: `patch not found: ${path}` }
    const check = git(['apply', '--check', '--3way', path], slotDirectory)
    if (!check.ok) {
      return { ok: false, applied, error: `${relative(toolRoot, path)} does not apply: ${check.stderr.trim()}` }
    }
    const result = git(['apply', '--3way', '--whitespace=nowarn', path], slotDirectory)
    if (!result.ok) {
      return { ok: false, applied, error: `${relative(toolRoot, path)} failed to apply: ${result.stderr.trim()}` }
    }
    applied.push(entry)
    logger(`applied patch ${entry}`)
  }
  return { ok: true, applied }
}
