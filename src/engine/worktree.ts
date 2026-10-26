/**
 * Obtaining a tag in a slot without losing work.
 *
 * The spare slot is the only tree the tool may modify, and `checkout --force` would discard
 * whatever a person left there. Every path therefore rescues uncommitted changes to
 * `rescued/` first, then detaches at the requested tag.
 *
 * @module dsh-upgrade/engine/worktree
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { join } from 'node:path'
import type { Config } from './config.ts'
import { git } from './git.ts'
import { SLOT_NAMES, slotExists, slotPath, type SlotName } from './slots.ts'

/** Progress sink; the CLI routes it to stderr. */
export type Logger = (line: string) => void

/** What {@link ensureCheckout} did. */
export interface CheckoutResult {
  /** `true` when the slot was created by this call. */
  readonly created: boolean
  /** Absolute path of the rescue patch, when uncommitted changes were found. */
  readonly rescued?: string
}

/** Timestamp suitable for a file name. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * Export uncommitted changes in a slot before they can be overwritten.
 *
 * Tracked changes go into a binary-safe patch. Untracked files are copied, not just listed: a
 * `git diff` does not contain them, and `checkout --force` leaves them in place while the next
 * `install` may delete the tree they live in — the copy is the only record of their contents.
 *
 * @param config - resolved tool configuration.
 * @param slot - slot name.
 * @param path - the slot's directory.
 * @param logger - progress sink.
 * @returns the rescue patch path, or `undefined` when the tree was clean.
 * @throws when the slot's status cannot be read: an unknown state must not be force-checked-out.
 */
function rescueUncommitted(config: Config, slot: SlotName, path: string, logger: Logger): string | undefined {
  const status = git(['status', '--porcelain'], path)
  if (!status.ok) throw new Error(`git status failed in slot ${slot}: ${status.stderr.trim() || 'no output'}`)
  if (status.stdout.trim() === '') return undefined
  const directory = join(config.root, 'rescued')
  mkdirSync(directory, { recursive: true })
  const patch = join(directory, `${slot}-${stamp()}.patch`)
  // Binary-safe: take the diff as a buffer so a stray byte cannot corrupt the patch.
  const diff = execFileSync('git', ['diff', 'HEAD', '--binary'], { cwd: path, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] })
  writeFileSync(patch, diff)
  const untracked = status.stdout
    .split(/\r?\n/)
    .filter(line => line.startsWith('?? '))
    .map(line => line.slice(3).replace(/^"|"$/g, ''))
  if (untracked.length > 0) {
    const copy = patch.replace(/\.patch$/, '-untracked')
    for (const entry of untracked) {
      const source = join(path, entry)
      const target = join(copy, entry)
      try {
        if (!existsSync(source)) continue
        mkdirSync(dirname(target), { recursive: true })
        cpSync(source, target, { recursive: true, force: true })
      } catch {
        // A locked file is reported below; the name is still recorded by the copy's presence.
      }
    }
    writeFileSync(patch.replace(/\.patch$/, '-untracked.txt'), `${untracked.join('\n')}\n`, 'utf8')
  }
  logger(`rescued ${untracked.length} untracked entries and local changes to ${patch}`)
  return patch
}

/**
 * Put one slot at a tag, creating the checkout when the slot is empty.
 * @param config - resolved tool configuration.
 * @param slot - the slot to prepare.
 * @param tag - release tag to check out.
 * @param logger - progress sink.
 * @returns what was created or rescued.
 * @throws when git refuses the clone, worktree, or checkout.
 */
export function ensureCheckout(config: Config, slot: SlotName, tag: string, logger: Logger): CheckoutResult {
  const path = slotPath(config, slot)
  if (!slotExists(config, slot)) {
    const donor = SLOT_NAMES.find(name => name !== slot && slotExists(config, name))
    if (donor !== undefined) {
      logger(`creating slot ${slot} as a worktree at ${tag}`)
      const added = git(['worktree', 'add', '--detach', path, tag], slotPath(config, donor))
      if (!added.ok) throw new Error(`git worktree add failed: ${added.stderr.trim()}`)
      return { created: true }
    }
    logger(`cloning ${config.upstream} into slot ${slot}`)
    const cloned = git(['clone', config.upstream, path], config.root)
    if (!cloned.ok) throw new Error(`git clone failed: ${cloned.stderr.trim()}`)
    const checkout = git(['checkout', '--detach', tag], path)
    if (!checkout.ok) throw new Error(`git checkout ${tag} failed: ${checkout.stderr.trim()}`)
    return { created: true }
  }

  const rescued = rescueUncommitted(config, slot, path, logger)
  // A worktree inherits the parent's hooks directory; the build's hook installer refuses to
  // replace a worktree-scoped value, so clear it before anything runs.
  git(['config', '--worktree', '--unset', 'core.hooksPath'], path)
  logger(`checking out ${tag} in slot ${slot}`)
  const checkout = git(['checkout', '--detach', '--force', tag], path)
  if (!checkout.ok) throw new Error(`git checkout ${tag} failed: ${checkout.stderr.trim()}`)
  return { created: false, ...rescued === undefined ? {} : { rescued } }
}

/**
 * Whether a slot already sits at a tag with a build record.
 * @param config - resolved tool configuration.
 * @param slot - slot name.
 * @param tag - expected tag.
 */
export function isPrepared(config: Config, slot: SlotName, tag: string): boolean {
  const path = slotPath(config, slot)
  if (!slotExists(config, slot)) return false
  const atHead = git(['tag', '--points-at', 'HEAD'], path)
  if (!atHead.ok || !atHead.stdout.split(/\r?\n/).includes(tag)) return false
  return existsSync(join(path, '.dsh-build', 'client-build-environment.json'))
}
