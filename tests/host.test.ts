/**
 * The platform seam: port ownership, process-tree termination, and the atomic link swap.
 *
 * These are the four behaviours the invariants rest on, so they are tested for their effect
 * (the port is bindable, the tree is gone, the link moved) rather than for the call.
 *
 * @module dsh-upgrade/tests/host
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { portFree, portOwner, replaceDirLink, terminateTree } from '../src/engine/host.ts'
import { skipUnlessPosix } from './helpers/platform.ts'
import { setLink } from '../src/engine/link.ts'

/** Sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Poll until a predicate holds.
 * @param predicate - the condition to wait for.
 * @param timeoutMs - upper bound.
 * @returns whether it held in time.
 */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(50)
  }
  return false
}

/**
 * Whether a process still exists.
 * @param pid - process id.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('portOwner names this process and portFree follows the listener', async () => {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  assert.equal(await portFree(address.port), false, 'a bound port is not free')
  assert.equal(portOwner(address.port), process.pid, 'the owner of our own listener is this process')
  await new Promise<void>(resolve => { server.close(() => resolve()) })
  assert.equal(await waitFor(() => portFree(address.port)), true, 'the port must be free after close')
})

test('terminateTree ends a detached child and its grandchild', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-upgrade-host-tree-'))
  const scriptPath = join(directory, 'tree.mjs')
  writeFileSync(scriptPath, [
    "import { spawn } from 'node:child_process'",
    "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })",
    'process.stdout.write(`${grandchild.pid}\\n`)',
    'setInterval(() => {}, 1000)',
  ].join('\n'), 'utf8')
  const child = spawn(process.execPath, [scriptPath], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  const leader = child.pid
  if (leader === undefined) assert.fail('the fixture child has no pid')
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  assert.equal(await waitFor(() => output.includes('\n')), true, 'the child must report its grandchild')
  const grandchild = Number(output.trim())
  assert.equal(Number.isInteger(grandchild) && grandchild > 0, true, `grandchild pid was ${output}`)

  terminateTree(leader)
  assert.equal(await waitFor(() => !alive(leader) && !alive(grandchild)), true, 'the whole tree must be gone')
})

test('replaceDirLink swaps the stable path and setLink refuses a real directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-host-link-'))
  const first = join(root, 'slot-a')
  const second = join(root, 'slot-b')
  mkdirSync(first)
  mkdirSync(second)
  const stable = join(root, 'deepseek-harness')

  replaceDirLink(stable, first)
  assert.match(readlinkSync(stable), /slot-a$/, 'the stable path must point at the first slot')
  replaceDirLink(stable, second)
  assert.match(readlinkSync(stable), /slot-b$/, 'replacing the link moves the serving slot')

  const real = join(root, 'hand-made')
  mkdirSync(real)
  assert.throws(() => setLink(real, first), /real directory/, 'a hand-made checkout is never replaced')
  assert.match(readlinkSync(stable), /slot-b$/, 'a refused switch must not move the stable path')
})

test('an IPv6-only listener is not a free port', async () => {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ port: 0, host: '::', ipv6Only: true }, resolve)
  })
  const address = server.address() as AddressInfo
  assert.equal(await portFree(address.port), false, 'a bound port is not free, whatever address family it uses')
  await new Promise<void>(resolve => { server.close(() => resolve()) })
  assert.equal(await waitFor(() => portFree(address.port)), true, 'the port must be free after close')
})

test('terminateTree ends a child that is not a group leader', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  const pid = child.pid
  if (pid === undefined) assert.fail('the fixture child has no pid')
  assert.equal(await waitFor(() => alive(pid)), true, 'the fixture child must be running')
  terminateTree(pid)
  assert.equal(await waitFor(() => !alive(pid)), true, 'a child without its own group must still be ended')
})

test('replaceDirLink replaces a broken symlink', (context) => {
  if (skipUnlessPosix(context)) return
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-host-broken-'))
  const stable = join(root, 'deepseek-harness')
  symlinkSync(join(root, 'gone'), stable)
  const target = join(root, 'slot-a')
  mkdirSync(target)
  replaceDirLink(stable, target)
  assert.match(readlinkSync(stable), /slot-a$/, 'a dangling link is replaced, not followed')
})
