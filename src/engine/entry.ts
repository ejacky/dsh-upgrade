/**
 * Where the CLI entry lives.
 *
 * Launchers, the scheduled task, and the tray all start the CLI as a child process. Deriving
 * the path from this module's own location keeps them correct whether the tool runs from a
 * source checkout, a green zip, or a package directory; `import.meta.filename` of the command
 * module itself is the command, never the entry.
 *
 * @module dsh-upgrade/engine/entry
 */
import { join } from 'node:path'

/**
 * Absolute path of the CLI entry point.
 * @returns the path of `src/cli.ts` beside this engine directory.
 */
export function cliEntryPath(): string {
  return join(import.meta.dirname, '..', 'cli.ts')
}
