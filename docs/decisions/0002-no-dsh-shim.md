# 0002 — No `dsh` shim

**Status:** accepted (2026-10)

## Context

The tool is invoked as `dsh-upgrade <command>`. Users already type `dsh` for the harness, and one
early idea was to install a `dsh` wrapper that forwards `dsh upgrade …` and `dsh tray …` to this
tool, so the surface would be one command.

## Decision

No shim. The entry point is `dsh-upgrade` (or `node <tool>\src\cli.ts`), and nothing named `dsh`
is ever written to `PATH` by this tool.

## Reasons

- **`dsh` belongs to the harness.** The harness is the thing being upgraded; its CLI is resolved
  from the slot the stable path serves. A `dsh` on `PATH` that sometimes means "the harness" and
  sometimes means "the upgrader" makes every bug report ambiguous, and a shim that forwards
  unknown arguments is a wrapper that can silently change harness behaviour.
- **Path ownership.** Putting a shim in a directory that is already on `PATH` (or adding a
  directory to `PATH`) is a machine-wide change made by a per-user tool. The one entry point that
  does need a stable name — the desktop launcher and the scheduled task — gets it from an absolute
  path written at install time.
- **Upgrades must not depend on the old version.** `apply` replaces the thing `dsh` would resolve
  to. A shim would have to survive its own upgrade, which means another copy of the tool that
  nobody updates.
- **Discoverability is not the problem.** `--help` lists every command, the tray exposes the four
  an operator uses, and the docs are a folder away. A second spelling of the same command does not
  make any of that easier.

## Consequences

- Two names live on the machine: `DeepSeek Harness` (the app, via the stable path) and
  `dsh-upgrade` (this tool). The docs always spell out which one a command belongs to.
- Scripts and shortcuts use the absolute path to `src\cli.ts`. `cliEntryPath()` in
  `src\engine\entry.ts` is the single place that computes it, and a test proves every generated
  launcher points there — a desktop launcher once started a command module instead of the CLI
  precisely because that path was derived twice.
- If a future harness exposes `dsh upgrade`, it should be a harness feature that calls this tool
  explicitly, not a shim installed here.
