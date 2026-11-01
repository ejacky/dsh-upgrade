/**
 * Deleting trees without following links.
 *
 * The layout deliberately contains links: junctions on Windows, symlinks elsewhere
 * (`stablePath` points into a slot, and a slot may contain linked `node_modules` entries). A
 * recursive delete that follows them would erase whichever tree they point at, so a link is
 * removed as a link and never descended.
 *
 * @module dsh-upgrade/engine/tree
 */
import { lstatSync, readdirSync, rmdirSync, rmSync, unlinkSync } from 'node:fs'
import { resolve, sep } from 'node:path'

/**
 * Assert a path is inside one of the allowed roots.
 * @param path - absolute path to test.
 * @param allowedRoots - roots that may contain it.
 * @throws when the path escapes every root.
 */
function assertInside(path: string, allowedRoots: readonly string[]): void {
  const target = resolve(path)
  const allowed = allowedRoots.some(root => {
    const base = resolve(root)
    return target === base || target.startsWith(`${base}${sep}`)
  })
  if (!allowed) throw new Error(`refusing to delete ${target}: outside ${allowedRoots.join(', ')}`)
}

/**
 * Delete a file or directory tree under an allowed root.
 *
 * Links are unlinked, never traversed; a missing path is not an error.
 * @param path - absolute path to delete.
 * @param allowedRoots - roots that may contain the path.
 */
export function removeTree(path: string, allowedRoots: readonly string[]): void {
  assertInside(path, allowedRoots)
  const stats = lstatSync(path, { throwIfNoEntry: false })
  if (stats === undefined) return
  if (stats.isSymbolicLink()) {
    unlinkSync(path)
    return
  }
  if (!stats.isDirectory()) {
    rmSync(path, { force: true })
    return
  }
  for (const entry of readdirSync(path)) removeTree(resolve(path, entry), allowedRoots)
  rmdirSync(path)
}

