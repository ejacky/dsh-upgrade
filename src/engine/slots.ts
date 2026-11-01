/**
 * Slot layout: two checkouts behind one stable path.
 *
 * `stablePath` (a junction on Windows, a symlink elsewhere) points at whichever slot is
 * serving. The other slot is the only one the tool writes while `stage` runs. Slots are
 * addressed by name so state and logs stay valid when a machine's layout is re-rooted.
 *
 * @module dsh-upgrade/engine/slots
 */
import { lstatSync, readlinkSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Config } from './config.ts'

/** The two slot names. */
export type SlotName = 'a' | 'b'

/** Both slot names, in a stable order. */
export const SLOT_NAMES: readonly SlotName[] = ['a', 'b']

/**
 * Directory of one slot.
 * @param config - resolved tool configuration.
 * @param name - slot name.
 */
export function slotPath(config: Config, name: SlotName): string {
  return join(config.slotsRoot, name)
}

/**
 * Whether the stable path currently resolves to a slot, and which one.
 *
 * A missing or non-link stable path means the layout is not initialized yet; that is a
 * normal state before `init`, not an error.
 * @param config - resolved tool configuration.
 * @returns the active slot name, or `undefined` when the stable path is absent or not a link.
 */
export function activeSlot(config: Config): SlotName | undefined {
  if (!existsSync(config.stablePath)) return undefined
  const stats = lstatSync(config.stablePath)
  if (!stats.isSymbolicLink()) return undefined
  const target = readlinkSync(config.stablePath)
  const resolved = resolve(config.stablePath, '..', target)
  for (const name of SLOT_NAMES) {
    if (resolve(slotPath(config, name)) === resolved) return name
  }
  return undefined
}

/**
 * The slot the tool may write.
 * @param config - resolved tool configuration.
 * @returns the slot that is not serving; before the first switch, slot `a`.
 */
export function spareSlot(config: Config): SlotName {
  const active = activeSlot(config)
  return active === 'a' ? 'b' : 'a'
}

/**
 * Whether a slot directory holds a checkout.
 * @param config - resolved tool configuration.
 * @param name - slot name.
 */
export function slotExists(config: Config, name: SlotName): boolean {
  return existsSync(join(slotPath(config, name), '.git'))
}
