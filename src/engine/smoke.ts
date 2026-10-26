/**
 * Smoking a built slot before anyone depends on it.
 *
 * The smoke runs the built CLI with an isolated `DSH_HOME` on a spare port and waits until
 * the server answers. Readiness is not "HTTP 200 on `/`": the web app answers 401 without a
 * token and prints the tokenized URL to its log, so the tokenized URL is preferred and 401 is
 * accepted as "listening".
 *
 * @module dsh-upgrade/engine/smoke
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config.ts'
import { removeTree } from './tree.ts'
import type { Logger } from './worktree.ts'

/** Upper bound for a server to start answering. */
const SMOKE_TIMEOUT_MS = 5 * 60 * 1000
/** Interval between readiness probes. */
const POLL_MS = 500

/** Outcome of a smoke run. */
export interface SmokeResult {
  /** Whether the server answered. */
  readonly ok: boolean
  /** URLs that were tried. */
  readonly urls: readonly string[]
  /** Why the smoke failed. */
  readonly error?: string
}

/**
 * Sleep.
 * @param ms - milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Try one URL.
 * @param url - absolute URL.
 * @returns 200, 401, or `undefined` when nothing answered.
 */
async function probe(url: string): Promise<number | undefined> {
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'manual' })
    return response.status
  } catch {
    return undefined
  }
}

/**
 * Start the built CLI in a slot and wait until it answers.
 * @param config - resolved tool configuration.
 * @param slotDirectory - the slot to run.
 * @param logPath - log file that also carries the tokenized URL.
 * @param logger - progress sink.
 * @returns whether the smoke passed.
 */
export async function smoke(config: Config, slotDirectory: string, logPath: string, logger: Logger): Promise<SmokeResult> {
  const entry = join(slotDirectory, 'apps', 'cli', 'lib', 'bin.js')
  if (!existsSync(entry)) return { ok: false, urls: [], error: `built CLI entry missing: ${entry}` }

  const home = join(config.root, 'state', 'smoke-home')
  removeTree(home, [config.root])
  mkdirSync(home, { recursive: true })

  const output: string[] = []
  const child = spawn(process.execPath, [entry, 'web', '--port', String(config.smokePort), '--no-open'], {
    cwd: slotDirectory,
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const absorb = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim() !== '') output.push(line)
    }
  }
  child.stdout.on('data', absorb)
  child.stderr.on('data', absorb)
  let exited: number | undefined
  child.on('exit', (code: number | null) => { exited = code ?? -1 })

  const urls: string[] = []
  const deadline = Date.now() + SMOKE_TIMEOUT_MS
  try {
    while (Date.now() < deadline) {
      const tokenised = output
        .map(line => /http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+)/.exec(line))
        .find(match => match !== null)
      if (tokenised !== null && tokenised !== undefined) {
        const url = tokenised[0]
        if (!urls.includes(url)) {
          urls.push(url)
          if (await probe(url) === 200) return { ok: true, urls }
        }
      }
      const bare = `http://127.0.0.1:${config.smokePort}/`
      if (!urls.includes(bare)) urls.push(bare)
      const status = await probe(bare)
      if (status === 200 || status === 401) return { ok: true, urls }
      if (exited !== undefined) {
        return { ok: false, urls, error: `server exited with ${exited} before answering` }
      }
      await sleep(POLL_MS)
    }
    return { ok: false, urls, error: `no answer on port ${config.smokePort} within ${SMOKE_TIMEOUT_MS / 1000}s` }
  } finally {
    if (exited === undefined) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } else {
        child.kill('SIGKILL')
      }
      logger('stopped the smoke server')
    }
    const { appendFileSync } = await import('node:fs')
    appendFileSync(logPath, `\n--- smoke output ---\n${output.join('\n')}\n`, 'utf8')
  }
}
