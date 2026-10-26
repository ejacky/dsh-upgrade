/**
 * The serving web process: who owns the port, how to stop it, how to start another.
 *
 * @module dsh-upgrade/engine/service
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config.ts'

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
 * The process listening on a port.
 * @param port - web port.
 * @returns the process id, or `undefined` when nothing listens.
 */
export function portOwner(port: number): number | undefined {
  if (process.platform !== 'win32') return undefined
  const result = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) return undefined
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.includes(`:${port} `) || !line.includes('LISTENING')) continue
    const columns = line.trim().split(/\s+/)
    const pid = Number(columns[columns.length - 1])
    if (Number.isInteger(pid) && pid > 0) return pid
  }
  return undefined
}

/**
 * Stop whatever serves the web port.
 * @param port - web port.
 * @returns `true` when a process was asked to stop.
 */
export function stopService(port: number): boolean {
  const pid = portOwner(port)
  if (pid === undefined) return false
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true })
  } else {
    try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  }
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
 * @param config - resolved tool configuration.
 * @param slotDirectory - the slot to serve.
 * @returns the started server handle.
 * @throws when the built entry is missing.
 */
export function startService(config: Config, slotDirectory: string): StartedService {
  const entry = join(slotDirectory, 'apps', 'cli', 'lib', 'bin.js')
  if (!existsSync(entry)) throw new Error(`built CLI entry missing: ${entry}`)
  const logPath = join(config.root, 'logs', `web-${config.webPort}.log`)
  const fd = openSync(logPath, 'a')
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
 * The tokenized URL from the log is preferred (plain `/` answers 401 by design); 401 on `/`
 * is accepted as "listening and serving".
 * @param config - resolved tool configuration.
 * @param logPath - the server log.
 * @returns whether the server answered in time.
 */
export async function waitForService(config: Config, logPath: string): Promise<boolean> {
  const deadline = Date.now() + START_TIMEOUT_MS
  const bare = `http://127.0.0.1:${config.webPort}/`
  while (Date.now() < deadline) {
    let tokenised: string | undefined
    if (existsSync(logPath)) {
      const text = readFileSync(logPath, 'utf8')
      tokenised = /http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/.exec(text)?.[0]
    }
    for (const url of [tokenised, bare]) {
      if (url === undefined) continue
      try {
        const response = await fetch(url, { redirect: 'manual' })
        if (response.status === 200 || response.status === 401) return true
      } catch {
        // not listening yet
      }
    }
    await sleep(POLL_MS)
  }
  return false
}

