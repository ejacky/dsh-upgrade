/**
 * Applying the configured source patches.
 *
 * Patches are the escape hatch for behaviour that has no configuration or plugin seam. A
 * patch that no longer applies must fail the stage loudly: staging a version with a
 * partially applied patch set would ship a tree nobody tested.
 *
 * Every check runs in both directions. A patch whose reverse application succeeds is
 * already in the tree — typically because the release contains the fix — so staging skips it
 * instead of failing. That makes a patch list survive the release that makes a patch
 * obsolete, and lets `patch verify` distinguish "already applied" from "does not apply".
 * @module dsh-upgrade/engine/patches
 */
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import type { Config } from './config.ts'
import { git } from './git.ts'
import { normalizePatchFile } from './patchManifest.ts'
import type { Logger } from './worktree.ts'

/** How a patch relates to a tree. */
export type PatchState =
  /** The patch's post-image is present; the tree already carries it. */
  | 'applied'
  /** The patch applies cleanly. */
  | 'applies'
  /** Neither direction applies: the patch needs a rebase. */
  | 'conflict'
  /** The patch file itself is missing. */
  | 'missing'

/** Result of checking one patch against one tree. */
export interface PatchCheck {
  /** Absolute path of the patch file. */
  readonly file: string
  /** How the patch relates to the tree. */
  readonly state: PatchState
  /** Why it conflicts, or why the file is missing. */
  readonly detail?: string
  /** How it must be applied: directly, or with a three-way merge. */
  readonly mode?: 'plain' | 'three-way'
}

/** Outcome of applying every configured patch. */
export interface PatchOutcome {
  /** Whether all patches applied or were already present. */
  readonly ok: boolean
  /** Paths that applied, as given in the configuration. */
  readonly applied: readonly string[]
  /** Paths the tree already contained, as given in the configuration. */
  readonly alreadyApplied: readonly string[]
  /** First failing patch and what the operator should do. */
  readonly error?: string
}

/**
 * Compress git's explanation to the lines an operator needs.
 * @param stderr - git's standard error.
 */
function summarize(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  return lines.slice(0, 4).join(' | ')
}

/**
 * Name a patch for a message: relative to the tool root when it lives there.
 * @param file - absolute patch path.
 * @param toolRoot - the tool's own directory.
 */
function displayPath(file: string, toolRoot: string): string {
  const relativePath = relative(toolRoot, file)
  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath)
    ? normalizePatchFile(relativePath)
    : file
}

/**
 * Resolve a configured patch entry to an absolute path.
 * @param entry - a path from `patchFiles`, absolute or relative to the tool root.
 * @param toolRoot - the tool's own directory.
 */
export function resolvePatchFile(entry: string, toolRoot: string): string {
  return isAbsolute(entry) ? entry : join(toolRoot, entry)
}

/**
 * Check one patch against a work tree without writing to it.
 *
 * The probes are plain `git apply --check` runs, not three-way merges: `--3way` refuses a
 * file whose working copy differs from the index, which is exactly the state a tree is in
 * after an earlier patch of the same list was applied. A three-way check is only the last
 * resort, for a patch that needs a merge rather than a clean apply.
 *
 * @param file - absolute patch path.
 * @param tree - a checkout to check against.
 * @returns how the patch relates to the tree.
 */
export function checkPatch(file: string, tree: string): PatchCheck {
  if (!existsSync(file)) return { file, state: 'missing', detail: 'file not found' }
  const reverse = git(['apply', '--check', '--reverse', file], tree)
  if (reverse.ok) return { file, state: 'applied' }
  const forward = git(['apply', '--check', file], tree)
  if (forward.ok) return { file, state: 'applies', mode: 'plain' }
  const merge = git(['apply', '--check', '--3way', file], tree)
  if (merge.ok) return { file, state: 'applies', mode: 'three-way' }
  const detail = summarize(forward.stderr) || summarize(merge.stderr)
  return { file, state: 'conflict', detail: detail === '' ? 'git apply rejected the patch' : detail }
}

/**
 * Apply `config.patchFiles` to a slot.
 * @param config - resolved tool configuration.
 * @param slotDirectory - the slot to patch.
 * @param toolRoot - directory that relative patch paths resolve against.
 * @param logger - progress sink.
 * @param tag - the version being staged, named in failure messages.
 * @returns what applied, what was already present, and the first failure.
 */
export function applyPatches(
  config: Config,
  slotDirectory: string,
  toolRoot: string,
  logger: Logger,
  tag?: string,
): PatchOutcome {
  const applied: string[] = []
  const alreadyApplied: string[] = []
  const target = tag ?? 'this tree'
  for (const entry of config.patchFiles) {
    const file = resolvePatchFile(entry, toolRoot)
    const name = displayPath(file, toolRoot)
    const check = checkPatch(file, slotDirectory)
    if (check.state === 'missing') return { ok: false, applied, alreadyApplied, error: `patch not found: ${file}` }
    if (check.state === 'applied') {
      alreadyApplied.push(entry)
      logger(`patch already present, skipping: ${name}`)
      continue
    }
    if (check.state === 'conflict') {
      return {
        ok: false,
        applied,
        alreadyApplied,
        error: `${name} does not apply to ${target}: ${check.detail ?? 'unknown error'}. `
          + `Rebase it onto ${target}, or remove it with "dsh-upgrade patch remove ${name}".`,
      }
    }
    const result = git(
      check.mode === 'three-way'
        ? ['apply', '--3way', '--whitespace=nowarn', file]
        : ['apply', '--whitespace=nowarn', file],
      slotDirectory,
    )
    if (!result.ok) {
      return {
        ok: false,
        applied,
        alreadyApplied,
        error: `${name} failed to apply to ${target}: ${summarize(result.stderr)}. `
          + 'Run "dsh-upgrade patch verify" to inspect it.',
      }
    }
    applied.push(entry)
    logger(`applied patch ${name}`)
  }
  return { ok: true, applied, alreadyApplied }
}
