/**
 * Thin, synchronous git access.
 *
 * The engine runs one git operation at a time and needs its exit status, never streaming
 * output, so a synchronous runner keeps the state machine linear and easy to reason about.
 *
 * @module dsh-upgrade/engine/git
 */
import { execFileSync } from 'node:child_process'

/** Outcome of one git invocation. */
export interface GitResult {
  /** Whether git exited 0. */
  readonly ok: boolean
  /** Captured stdout. */
  readonly stdout: string
  /** Captured stderr, or the spawn error message. */
  readonly stderr: string
}

/**
 * Run git in a repository directory.
 * @param args - arguments after the executable.
 * @param cwd - directory to run in.
 * @returns the captured result; never throws.
 */
export function git(args: readonly string[], cwd: string): GitResult {
  try {
    const stdout = execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, stdout, stderr: '' }
  } catch (error) {
    const failure = error as { stdout?: unknown, stderr?: unknown, message?: string }
    return {
      ok: false,
      stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
      stderr: typeof failure.stderr === 'string' && failure.stderr !== '' ? failure.stderr : (failure.message ?? 'git failed'),
    }
  }
}

/**
 * Fetch upstream tags into the repository.
 * @param repo - any worktree of the repository.
 * @param upstream - the git URL to fetch from.
 */
export function fetchTags(repo: string, upstream: string): GitResult {
  return git(['fetch', '--tags', '--prune', '--quiet', upstream], repo)
}

/**
 * List tags, newest by semver where parseable (git's own order is lexicographic).
 * @param repo - any worktree of the repository.
 * @param pattern - optional glob passed to `git tag --list`.
 */
export function listTags(repo: string, pattern?: string): string[] {
  const result = git(pattern === undefined ? ['tag', '--list'] : ['tag', '--list', pattern], repo)
  if (!result.ok) return []
  return result.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
}

/**
 * List tags on a remote without a local repository.
 * @param upstream - git URL.
 * @param cwd - directory to run git in.
 */
export function lsRemoteTags(upstream: string, cwd: string): string[] {
  const result = git(['ls-remote', '--tags', '--refs', upstream], cwd)
  if (!result.ok) return []
  return result.stdout
    .split(/\r?\n/)
    .map(line => /refs\/tags\/(.+)$/.exec(line.trim())?.[1])
    .filter((tag): tag is string => tag !== undefined && tag !== '')
}

/**
 * The tag a checkout points at, if any.
 * @param slotPath - the slot's directory.
 */
export function tagAtHead(slotPath: string): string | undefined {
  const result = git(['tag', '--points-at', 'HEAD'], slotPath)
  if (!result.ok) return undefined
  const first = result.stdout.split(/\r?\n/).map(line => line.trim()).find(line => line !== '')
  return first
}

