/**
 * One writer at a time.
 *
 * `stage`, `apply`, and `rollback` all mutate the layout, so a second run must not start while
 * the first is alive. The lock is a file holding a pid and a start time.
 *
 * Creation is atomic: the record is written to a private temporary file and then hard-linked
 * into place, so a contender can never observe a half-written lock and declare it stale (an
 * exclusive `open` followed by a write can be seen empty by the next process). Releasing checks
 * that the file still names this process, so a run whose lock was reclaimed cannot delete the
 * lock a newer run now holds.
 *
 * A leftover lock is reclaimed only when its pid is gone, or when it is old enough that pid
 * reuse is the likelier explanation than a live run: a build step alone may take hours.
 *
 * @module dsh-upgrade/engine/lock
 */
import { closeSync, linkSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Held lock, released exactly once. */
export interface Lock {
  /** Remove the lock file when it still names this process; idempotent. */
  release(): void
}

/** Contents written into the lock file. */
interface LockRecord {
  readonly pid: number
  readonly startedAt: string
}

/**
 * Age after which a leftover lock is reclaimed even if its pid still exists.
 *
 * The longest legitimate run is a stage on a slow machine: install (2 h), build (25 min), and a
 * smoke test (5 min). A day leaves room for two of those back to back and still reclaims a lock
 * whose pid was reused by an unrelated process.
 */
const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000

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

/**
 * Publish a record atomically at `path`.
 * @param path - absolute path to the lock file.
 * @param record - the record to publish.
 * @returns `true` when the record now exists and names this process.
 */
function publish(path: string, record: LockRecord): boolean {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(record), 'utf8')
  try {
    linkSync(temporary, path)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return false
    // A filesystem without hard links still supports an exclusive create.
    try {
      const handle = openSync(path, 'wx')
      try {
        writeFileSync(handle, JSON.stringify(record), 'utf8')
      } finally {
        closeSync(handle)
      }
      return true
    } catch (fallback) {
      if ((fallback as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw fallback
    }
  } finally {
    rmSync(temporary, { force: true })
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
  const record: LockRecord = { pid: process.pid, startedAt: new Date().toISOString() }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (publish(path, record)) {
      let released = false
      return {
        release(): void {
          if (released) return
          released = true
          // Only remove a lock that still names this process: another run may have reclaimed it.
          const current = readRecord(path)
          if (current !== undefined && current.pid !== process.pid) return
          rmSync(path, { force: true })
        },
      }
    }
    const current = readRecord(path)
    const stale = current === undefined
      || !isAlive(current.pid)
      || Date.now() - Date.parse(current.startedAt) > staleMs
    if (!stale) return undefined
    // Reclaiming is racy by nature; the atomic publish decides which contender wins.
    try {
      unlinkSync(path)
    } catch {
      // Someone else already reclaimed it; retry the publish.
    }
  }
  return undefined
}
