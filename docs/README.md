# Documentation

| Document | Read it when |
|---|---|
| [quick-start.md](quick-start.md) | installing the zip and doing the first upgrade |
| [commands.md](commands.md) | you need a flag, a JSON field, or an exit code |
| [design.md](design.md) | you are changing the tool, or wondering why a rule exists |
| [troubleshooting.md](troubleshooting.md) | something failed |
| [patch-tracks.md](patch-tracks.md) | you are writing, verifying, or retiring a source patch |
| [distribution.md](distribution.md) | building or installing a release, or migrating from the legacy scripts |
| [opencode-session.md](opencode-session.md) | the gateway session header is missing, or you want different settings |

## Decision records

| Record | Question it answers |
|---|---|
| [0001-no-windows-service](decisions/0001-no-windows-service.md) | why nothing runs as a Windows service |
| [0002-no-dsh-shim](decisions/0002-no-dsh-shim.md) | why the entry point is only `dsh-upgrade` |

## Conventions

- Every command has a `--json` form; the JSON is what the tray and the scheduled task read, so a
  field name is a compatibility promise.
- Exit codes are a contract: `0` success, `2` usage, `3` needs a human, `4` probe failure, `5`
  reserved for a command that is part of the surface but not implemented.
- The serving slot is never written, and nothing switches versions without an explicit `apply`.
