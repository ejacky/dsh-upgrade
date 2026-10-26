/**
 * One writer at a time.
 *
 * `stage` and `apply` both mutate the layout, so a second run must not start while the
 * first is alive. The lock is a file holding a pid and a start time: a crash leaves a stale
 * file, which a later run reclaims once the pid is gone or the file is old enough.
 *
 * @module dsh-upgrade/engine/lock
 */
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Held lock, released exactly once. */
export interface Lock {
  /** Remove the lock file; idempotent. */
  release(): void
}

/** Contents written into the lock file. */
interface LockRecord {
  readonly pid: number
  readonly startedAt: string
}

/** Default staleness: longer than any legitimate build, shorter than a working day. */
const DEFAULT_STALE_MS = 3 * 60 * 60 * 1000

/**
 * Whether a process id is still running.
 * @param pid - the id to test.
 */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Try to take the lock.
 * @param path - absolute path to the lock file.
 * @param staleMs - age after which a leftover lock is reclaimed even if its pid lives on.
 * @returns the lock, or `undefined` when another live run holds it.
 */
export function acquireLock(path: string, staleMs = DEFAULT_STALE_MS): Lock | undefined {
  mkdirSync(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = openSync(path, 'wx')
      const record: LockRecord = { pid: process.pid, startedAt: new Date().toISOString() }
      writeSync(handle, JSON.stringify(record))
      closeSync(handle)
      let released = false
      return {
        release(): void {
          if (released) return
          released = true
          rmSync(path, { force: true })
        },
      }
    } catch {
      if (!existsSync(path)) return undefined
      const record = readRecord(path)
      const stale = record === undefined
        || !isAlive(record.pid)
        || Date.now() - Date.parse(record.startedAt) > staleMs
      if (!stale) return undefined
      rmSync(path, { force: true })
    }
  }
  return undefined
}

/**
 * Read the lock file, treating a malformed one as stale.
 * @param path - absolute path to the lock file.
 */
function readRecord(path: string): LockRecord | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof raw !== 'object' || raw === null) return undefined
    const record = raw as Record<string, unknown>
    if (typeof record['pid'] !== 'number' || typeof record['startedAt'] !== 'string') return undefined
    return { pid: record['pid'], startedAt: record['startedAt'] }
  } catch {
    return undefined
  }
}
