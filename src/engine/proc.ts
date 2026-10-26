/**
 * Running external commands with a log file, a timeout, and a captured tail.
 *
 * Every long step (install, build, smoke) needs the same three things: its own log, an
 * upper bound on wall time, and enough trailing output to explain a failure. stdin is
 * `ignore` so a prompt can never block an unattended run.
 *
 * @module dsh-upgrade/engine/proc
 */
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** How many trailing lines are kept for error messages. */
const TAIL_LINES = 40

/** One command to run. */
export interface ProcOptions {
  /** Executable (or script run by `node`, see {@link pnpmInvocation}). */
  readonly file: string
  /** Arguments after the executable. */
  readonly args: readonly string[]
  /** Working directory. */
  readonly cwd: string
  /** File that receives stdout and stderr, appended. */
  readonly logPath: string
  /** Wall-clock limit; the process tree is killed when it expires. */
  readonly timeoutMs: number
  /** Extra environment variables layered over the parent's. */
  readonly env?: Readonly<Record<string, string>>
  /** Run through a shell (needed for `.cmd` shims). */
  readonly shell?: boolean
}

/** Outcome of one command. */
export interface ProcResult {
  /** Exit code, or `-1` when the process could not start or was killed. */
  readonly code: number
  /** Whether {@link ProcOptions.timeoutMs} expired and the tree was killed. */
  readonly timedOut: boolean
  /** Last {@link TAIL_LINES} lines of combined output. */
  readonly tail: readonly string[]
}

/**
 * Run a command, appending its output to a log.
 * @param options - what to run and how to bound it.
 * @returns the exit status and the trailing output.
 */
export function runLogged(options: ProcOptions): Promise<ProcResult> {
  mkdirSync(dirname(options.logPath), { recursive: true })
  const log = createWriteStream(options.logPath, { flags: 'a' })
  const tail: string[] = []
  const absorb = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line === '') continue
      tail.push(line)
      if (tail.length > TAIL_LINES) tail.shift()
    }
  }
  const child = spawn(options.file, [...options.args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    // `ignore` hands the child a null device: an interactive prompt reads EOF instead of
    // waiting forever, which is the difference between a failed step and a hung one.
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...options.shell === true ? { shell: true } : {},
  })
  child.stdout.on('data', (chunk: Buffer) => { absorb(chunk); log.write(chunk) })
  child.stderr.on('data', (chunk: Buffer) => { absorb(chunk); log.write(chunk) })

  return new Promise<ProcResult>(resolve => {
    let settled = false
    const finish = (code: number, timedOut: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      log.end()
      resolve({ code, timedOut, tail })
    }
    const timer = setTimeout(() => {
      killTree(child.pid)
      finish(-1, true)
    }, options.timeoutMs)
    child.on('error', (error: Error) => {
      absorb(Buffer.from(String(error.message)))
      finish(-1, false)
    })
    child.on('close', (code: number | null) => finish(code ?? -1, false))
  })
}

/**
 * Kill a process and its descendants.
 * @param pid - root process id, when known.
 */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // The tree may already be gone; nothing useful to do.
  }
}
