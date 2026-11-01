/**
 * Platform facts shared by the suite: which assertions can run here, and the small helpers that
 * used to be Windows-only copies inside individual test files.
 *
 * A platform-specific implementation gets a platform-specific test; a test that would silently
 * skip everywhere is worse than no test at all, so each skip names the other implementation.
 *
 * @module dsh-upgrade/tests/helpers/platform
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { portOwner, terminateTree } from '../../src/engine/host.ts'

/** The part of a `node:test` context these helpers need. */
interface SkippableContext {
  /** Mark the test as skipped. */
  skip(message?: string): void
}

/** Whether the suite runs on Windows. */
export const IS_WINDOWS = process.platform === 'win32'

/**
 * Skip the current test unless it is running on Windows.
 * @param context - the `node:test` context supplied to the test body.
 * @returns `true` when the body must return immediately.
 */
export function skipUnlessWindows(context: SkippableContext, reason = 'Windows-only implementation'): boolean {
  if (IS_WINDOWS) return false
  context.skip(reason)
  return true
}

/**
 * Skip the current test unless it is running on a POSIX system.
 * @param context - the `node:test` context supplied to the test body.
 * @returns `true` when the body must return immediately.
 */
export function skipUnlessPosix(context: SkippableContext, reason = 'Linux-only implementation'): boolean {
  if (!IS_WINDOWS) return false
  context.skip(reason)
  return true
}

/**
 * Stop whatever serves a port, so a leaked listener cannot fail a later test.
 * @param port - the port to evacuate.
 */
export function stopPort(port: number): void {
  const pid = portOwner(port)
  if (pid !== undefined) terminateTree(pid)
}

/**
 * Expand an archive the way the platform's installer does.
 * @param archive - absolute archive path.
 * @param destination - directory to unpack into.
 */
export function unpack(archive: string, destination: string): void {
  mkdirSync(destination, { recursive: true })
  const result = IS_WINDOWS
    ? spawnSync('pwsh', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path '${archive.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`,
    ], { encoding: 'utf8' })
    : spawnSync('tar', ['-xzf', archive, '-C', destination], { encoding: 'utf8' })
  assert.equal(result.error, undefined, `unpack failed: ${String(result.error)}`)
  assert.equal(result.status, 0, `unpack failed: ${result.stderr}`)
}
