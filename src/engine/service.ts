/**
 * The serving web process: who owns the port, how to stop it, how to start another.
 *
 * The platform-varying parts (finding the owner, ending the tree) live in `host.ts`. What stays
 * here is the readiness contract: a switch succeeded only when a URL the new process printed
 * answers, or when a bare answer comes from the process this call started.
 *
 * @module dsh-upgrade/engine/service
 */
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { existsSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { portOwner, terminateTree } from './host.ts'
import type { Config } from './config.ts'

export { portOwner } from './host.ts'

/** How long a freshly started server may take to answer; DSH_UPGRADE_START_TIMEOUT_MS overrides it. */
const START_TIMEOUT_MS = Number(process.env['DSH_UPGRADE_START_TIMEOUT_MS'] ?? 5 * 60 * 1000)
/** Readiness polling interval. */
const POLL_MS = 500

/**
 * Sleep.
 * @param ms - milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Ask a URL for its status without throwing.
 * @param url - absolute URL.
 * @returns the HTTP status, or `undefined` when nothing answered.
 */
async function statusOf(url: string): Promise<number | undefined> {
  try {
    const response = await fetch(url, { redirect: 'manual' })
    return response.status
  } catch {
    return undefined
  }
}

/**
 * Stop whatever serves the web port.
 *
 * Termination is asynchronous on POSIX, so the return value only says whether a listener was
 * found and signalled; a caller that needs the port free must poll `portFree`.
 * @param port - web port.
 * @returns whether a listener was signalled.
 */
export function stopService(port: number): boolean {
  const pid = portOwner(port)
  if (pid === undefined) return false
  terminateTree(pid)
  return true
}

/** A started server. */
export interface StartedService {
  /** Process id of the detached server. */
  readonly pid: number | undefined
  /** Log that receives its output. */
  readonly logPath: string
}

/**
 * Start a slot's built web app detached, so it outlives this process.
 *
 * The previous attempt's log is kept as `web-<port>.prev.log` before the new run truncates it:
 * the readiness parser must not see a stale token, but the failure it described is the evidence
 * an operator needs.
 * @param config - resolved tool configuration.
 * @param slotDirectory - the slot to serve.
 * @returns the started server handle.
 * @throws when the built entry is missing.
 */
export function startService(config: Config, slotDirectory: string): StartedService {
  const entry = join(slotDirectory, 'apps', 'cli', 'lib', 'bin.js')
  if (!existsSync(entry)) throw new Error(`built CLI entry missing: ${entry}`)
  const logPath = join(config.root, 'logs', `web-${config.webPort}.log`)
  if (existsSync(logPath) && statSync(logPath).size > 0) {
    renameSync(logPath, `${logPath}.prev.log`)
  }
  const fd = openSync(logPath, 'w')
  try {
    const child = spawn(process.execPath, [entry, 'web', '--port', String(config.webPort), '--no-open'], {
      cwd: slotDirectory,
      stdio: ['ignore', fd, fd],
      detached: true,
      windowsHide: true,
    })
    child.unref()
    return { pid: child.pid, logPath }
  } finally {
    closeSync(fd)
  }
}

/**
 * Wait until the web port answers.
 *
 * The tokenized URL from the log is preferred (plain `/` answers 401 by design) and proves the
 * answering process was started with that token. A bare `/` answer is accepted only when the
 * listener is the process this call started: otherwise an old build still holding the port would
 * make a failed switch look successful.
 * @param config - resolved tool configuration.
 * @param logPath - the server log.
 * @param expectedPid - the pid `startService` returned for this attempt.
 * @returns whether the server answered in time.
 */
export async function waitForService(config: Config, logPath: string, expectedPid?: number): Promise<boolean> {
  const deadline = Date.now() + START_TIMEOUT_MS
  const bare = `http://127.0.0.1:${config.webPort}/`
  while (Date.now() < deadline) {
    let tokenised: string | undefined
    if (existsSync(logPath)) {
      const text = readFileSync(logPath, 'utf8')
      // The log belongs to this attempt (each start rotates the previous one), so the last match
      // is this run's token.
      tokenised = [...text.matchAll(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=\S+/g)].at(-1)?.[0]
    }
    if (tokenised !== undefined) {
      const status = await statusOf(tokenised)
      if (status === 200 || status === 401) return true
    }
    if (expectedPid !== undefined) {
      // Asking for the owner is only worth a `/proc` walk once the bare URL actually answered.
      const status = await statusOf(bare)
      if ((status === 200 || status === 401) && portOwner(config.webPort) === expectedPid) return true
    }
    await sleep(POLL_MS)
  }
  return false
}
