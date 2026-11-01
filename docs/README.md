# Documentation

| Document | Read it when |
|---|---|
| [quick-start.md](quick-start.md) | installing the release and doing the first upgrade |
| [commands.md](commands.md) | you need a flag, a JSON field, or an exit code |
| [design.md](design.md) | you are changing the tool, or wondering why a rule exists |
| [troubleshooting.md](troubleshooting.md) | something failed |
| [patch-tracks.md](patch-tracks.md) | you are writing, verifying, or retiring a source patch |
| [distribution.md](distribution.md) | building or installing a release, or migrating from the legacy scripts |

## Decision records

| Record | Question it answers |
|---|---|
| [0001-no-windows-service](decisions/0001-no-windows-service.md) | why nothing runs as a system service |
| [0002-no-dsh-shim](decisions/0002-no-dsh-shim.md) | why the entry point is only `dsh-upgrade` |
| [0003-linux-parity](decisions/0003-linux-parity.md) | how Linux support is scoped, and what Windows keeps |
| [0004-retire-opencode-session-plugin](decisions/0004-retire-opencode-session-plugin.md) | why the bundled gateway plugin was removed |

## Conventions

- Every command has a `--json` form; the tray and the watcher read it, so a field name is a
  compatibility promise.
- Exit codes are a contract: `0` success, `2` usage, `3` needs a human, `4` probe failure, `5`
  reserved for a command that is part of the surface but not implemented.
- The serving slot is never written, and nothing switches versions without an explicit `apply`.
- A platform capability that does not exist fails with `3` and a next action; it is never silently
  skipped.
