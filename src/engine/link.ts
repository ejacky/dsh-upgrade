/**
 * The stable path: one link that names whichever slot is serving.
 *
 * A Windows junction and a POSIX symlink are both a single directory entry, so replacing it is
 * the switch. Refusing to replace a real directory keeps the tool from swallowing a hand-made
 * checkout; the replacement itself lives in `host.ts`, where the two platforms differ.
 *
 * @module dsh-upgrade/engine/link
 */
import { existsSync, lstatSync, readlinkSync } from 'node:fs'
import { replaceDirLink } from './host.ts'

/**
 * What the stable path currently is.
 * @param path - the stable path.
 * @returns `'absent'`, `'link'` with its target, or `'directory'` for a real directory.
 */
export function describeLink(path: string): { kind: 'absent' } | { kind: 'link', target: string } | { kind: 'directory' } {
  if (!existsSync(path)) return { kind: 'absent' }
  const stats = lstatSync(path)
  if (stats.isSymbolicLink()) return { kind: 'link', target: readlinkSync(path) }
  return { kind: 'directory' }
}

/**
 * Point the stable path at a slot, creating or replacing the link.
 * @param path - the stable path.
 * @param target - slot directory to point at.
 * @throws when the path is a real directory (a checkout the tool did not create).
 */
export function setLink(path: string, target: string): void {
  const current = describeLink(path)
  if (current.kind === 'directory') {
    throw new Error(`${path} is a real directory, not a link; move it aside first (see docs/design.md)`)
  }
  replaceDirLink(path, target)
}
