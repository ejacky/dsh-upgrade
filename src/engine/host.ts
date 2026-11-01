/**
 * The platform seam: the primitives that are not the same on Windows and Linux.
 *
 * A port's owner, ending a process tree, replacing the stable-path link, choosing where a
 * launcher lives, and the two spawn details (process group, package-manager executable) live
 * here. A command asks for the behaviour instead of "which OS am I on", so a platform that
 * cannot provide it fails loudly instead of reporting an effect it did not observe.
 *
 * "Is this port free?" is answered per platform by the most reliable evidence available: the
 * listener table on Windows, `/proc` plus a bind probe elsewhere.
 *
 * @module dsh-upgrade/engine/host
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** Whether this process runs on Windows. */
export const IS_WINDOWS = process.platform === 'win32'

/**
 * Whether a long-running child should get its own process group.
 *
 * A POSIX group is what makes `terminateTree` reach the children of `pnpm`; Windows uses
 * `taskkill /T` instead, so a group there would only add a console.
 * @returns `true` on POSIX.
 */
export function childProcessGroup(): boolean {
  return !IS_WINDOWS
}

/**
 * The package manager's executable name.
 * @returns `pnpm.cmd` on Windows, `pnpm` elsewhere.
 */
export function pnpmShim(): string {
  return IS_WINDOWS ? 'pnpm.cmd' : 'pnpm'
}

/** How long a POSIX process tree gets after `SIGTERM` before it is killed outright. */
const KILL_GRACE_MS = 2_000

/** How often the tree is re-checked while the grace period runs. */
const KILL_POLL_MS = 100

/**
 * Whether nothing serves a port right now.
 *
 * Windows keeps the check it always had: a port is free when `netstat` names no listener. That
 * also avoids relying on a duplicate bind being refused, which is a platform detail rather than
 * a contract.
 *
 * Elsewhere `/proc` is asked first, because it lists every listening socket in the namespace —
 * including another account's and an IPv6-only one, which a bind to 127.0.0.1 would not notice.
 * The bind probe is the second opinion, and only `EADDRINUSE` proves a listener: a privileged
 * or reserved port refuses every bind, and that must not read as "busy" forever.
 * @param port - TCP port.
 * @returns `true` when nothing is listening.
 */
export function portFree(port: number): Promise<boolean> {
  if (IS_WINDOWS) return Promise.resolve(portOwner(port) === undefined)
  if (listeningInodes(port).size > 0) return Promise.resolve(false)
  return bindProbe(port)
}

/**
 * Try to bind the loopback address and close again.
 * @param port - TCP port.
 * @returns `true` when the bind succeeded or failed for a reason other than a listener.
 */
function bindProbe(port: number): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const server = createServer()
    server.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code !== 'EADDRINUSE' && portOwner(port) === undefined)
    })
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close(() => { resolve(true) })
    })
  })
}

/**
 * Sleep.
 * @param ms - milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Wait until a port is free.
 *
 * Every caller that reports "stopped" must go through this: the observation, not the signal, is
 * what makes the report true.
 * @param port - TCP port.
 * @param timeoutMs - upper bound.
 * @returns whether the port was free before the deadline.
 */
export async function waitPortFree(port: number, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portFree(port)) return true
    await sleep(300)
  }
  return portFree(port)
}

/**
 * The process listening on a port.
 * @param port - TCP port.
 * @returns the process id, or `undefined` when nothing listens or the owner cannot be named.
 */
export function portOwner(port: number): number | undefined {
  return IS_WINDOWS ? windowsPortOwner(port) : posixPortOwner(port)
}

/**
 * Find the owner of a listening port with `netstat`.
 * @param port - TCP port.
 * @returns the process id, or `undefined`.
 */
function windowsPortOwner(port: number): number | undefined {
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
 * Find the owner of a listening port on Linux.
 *
 * `/proc` is authoritative and needs no tool, but it can only see this user's processes. When
 * it cannot name the owner, `ss` and then `lsof` are tried, because a port held by another
 * account is exactly the case a stop must not misreport.
 * @param port - TCP port.
 * @returns the process id, or `undefined`.
 */
function posixPortOwner(port: number): number | undefined {
  const inodes = listeningInodes(port)
  if (inodes.size > 0) {
    const pid = pidOfSockets(inodes)
    if (pid !== undefined) return pid
  }
  return ssPortOwner(port) ?? lsofPortOwner(port)
}

/**
 * Socket inodes of the sockets listening on a port.
 * @param port - TCP port.
 * @returns the inodes, empty when nothing listens.
 */
function listeningInodes(port: number): Set<string> {
  const wanted = port.toString(16).toUpperCase().padStart(4, '0')
  const inodes = new Set<string>()
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      // A kernel without this table falls back to `ss`.
      continue
    }
    for (const line of text.split('\n').slice(1)) {
      const columns = line.trim().split(/\s+/)
      const local = columns[1]
      const state = columns[3]
      const inode = columns[9]
      if (local === undefined || state === undefined || inode === undefined) continue
      if (state !== '0A') continue
      const colon = local.lastIndexOf(':')
      if (colon === -1) continue
      if (local.slice(colon + 1).toUpperCase() !== wanted) continue
      if (inode !== '0') inodes.add(inode)
    }
  }
  return inodes
}

/**
 * The process holding one of these sockets.
 * @param inodes - socket inodes from `/proc/net/tcp`.
 * @returns the process id, or `undefined` when no readable process holds them.
 */
function pidOfSockets(inodes: Set<string>): number | undefined {
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const directory = `/proc/${entry}/fd`
    let descriptors: string[]
    try {
      descriptors = readdirSync(directory)
    } catch {
      // Another user's process: its descriptors are not readable, which is why `ss` exists.
      continue
    }
    for (const descriptor of descriptors) {
      let target: string
      try {
        target = readlinkSync(join(directory, descriptor))
      } catch {
        continue
      }
      const match = /^socket:\[(\d+)\]$/.exec(target)
      if (match !== null && match[1] !== undefined && inodes.has(match[1])) return Number(entry)
    }
  }
  return undefined
}

/**
 * Ask `ss` for the listening socket's pid.
 * @param port - TCP port.
 * @returns the process id, or `undefined` when `ss` is absent or shows no pid.
 */
function ssPortOwner(port: number): number | undefined {
  const result = spawnSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' })
  if (result.error !== undefined || result.status !== 0) return undefined
  const match = /pid=(\d+)/.exec(result.stdout)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

/**
 * Ask `lsof` for the listening socket's pid.
 * @param port - TCP port.
 * @returns the process id, or `undefined` when `lsof` is absent or shows no pid.
 */
function lsofPortOwner(port: number): number | undefined {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
  if (result.error !== undefined || result.status !== 0) return undefined
  const first = result.stdout.split(/\r?\n/).map(line => line.trim()).find(line => /^\d+$/.test(line))
  return first === undefined ? undefined : Number(first)
}

/**
 * End a process and its descendants.
 *
 * Windows uses `taskkill /T /F`. Elsewhere the caller's children were started in their own
 * process group, so the group is signalled; a group that ignores `SIGTERM` is killed after a
 * short grace period. Escalation checks that the group leader is still the process that was
 * signalled: a pgid can be reused meanwhile, and killing a stranger is worse than missing one
 * stubborn process.
 * @param pid - root process id.
 */
export function terminateTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true })
    return
  }
  const identity = processStartTime(pid)
  if (!signalTree(pid, 'SIGTERM')) return
  const started = Date.now()
  // Deliberately not `unref()`ed: a caller that reports "stopped" must not exit before the
  // escalation had its chance, or a SIGTERM-ignoring build keeps writing into the slot.
  const escalate = (): void => {
    const current = processStartTime(pid)
    if (identity !== undefined && current !== undefined && current !== identity) return
    if (!processTreeAlive(pid)) return
    if (Date.now() - started >= KILL_GRACE_MS) {
      signalTree(pid, 'SIGKILL')
      return
    }
    setTimeout(escalate, KILL_POLL_MS)
  }
  setTimeout(escalate, KILL_POLL_MS)
}

/**
 * The kernel's start time for a process, used as its identity.
 *
 * `/proc/<pid>/stat` is `pid (comm) state ...`; `comm` may contain spaces and parentheses, so
 * the fields are read after the last `)`.
 * @param pid - process id.
 * @returns the start time in clock ticks, or `undefined` when it cannot be read.
 */
function processStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    if (close === -1) return undefined
    const fields = stat.slice(close + 2).trim().split(/\s+/)
    return fields[19]
  } catch {
    return undefined
  }
}

/**
 * Send a signal to a process group, falling back to the process itself.
 * @param pid - root process id.
 * @param signal - signal name.
 * @returns whether a signal was delivered.
 */
function signalTree(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    try {
      process.kill(pid, signal)
      return true
    } catch {
      return false
    }
  }
}

/**
 * Whether a process group or its leader still exists.
 * @param pid - root process id.
 * @returns `true` while either can be signalled.
 */
export function processTreeAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
}

/**
 * Point a stable path at a directory, replacing whatever link is there.
 *
 * Windows needs two steps for a junction (unlink, then create) because there is no rename that
 * preserves the junction type. Elsewhere a temporary symlink is renamed over the old one, which
 * is atomic: the stable path never disappears, so a process starting at that moment resolves
 * either the old slot or the new one, never nothing.
 * @param path - the stable path.
 * @param target - directory to point at.
 * @throws when the path is a real directory or the rename is refused.
 */
export function replaceDirLink(path: string, target: string): void {
  if (IS_WINDOWS) {
    try {
      unlinkSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    symlinkSync(target, path, 'junction')
    return
  }
  const temporary = `${path}.${process.pid}.link`
  rmSync(temporary, { force: true })
  symlinkSync(target, temporary, 'dir')
  try {
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/**
 * Directory the launchers belong in.
 *
 * Windows uses the real desktop folder (a OneDrive-redirected one is common); POSIX uses the
 * application menu, where a `.desktop` file is what "install a launcher" means.
 * @returns the absolute directory.
 */
export function shortcutDirectory(): string {
  if (!IS_WINDOWS) {
    const base = absoluteEnv('XDG_DATA_HOME') ?? join(homedir(), '.local', 'share')
    return join(base, 'applications')
  }
  const probe = spawnSync('pwsh', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"], { encoding: 'utf8' })
  const desktop = (probe.stdout ?? '').trim()
  return desktop !== '' ? desktop : join(process.env['USERPROFILE'] ?? '', 'Desktop')
}

/**
 * Directory for systemd user units.
 * @returns `$XDG_CONFIG_HOME/systemd/user`, defaulting to `~/.config/systemd/user`.
 */
export function systemdUserDirectory(): string {
  const base = absoluteEnv('XDG_CONFIG_HOME') ?? join(homedir(), '.config')
  return join(base, 'systemd', 'user')
}

/**
 * Read a directory from the environment, ignoring a relative value.
 *
 * The XDG spec says a relative value is invalid and must be ignored; accepting one would put
 * units and launchers wherever the current directory happens to be.
 * @param name - environment variable name.
 * @returns the absolute directory, or `undefined` when unset, empty, or relative.
 */
function absoluteEnv(name: string): string | undefined {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') return undefined
  return isAbsolute(value.trim()) ? value.trim() : undefined
}
