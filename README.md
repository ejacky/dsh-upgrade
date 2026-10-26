# dsh-upgrade

Zero-downtime upgrades for a **DeepSeek Harness source checkout** on Windows.

> **Status: M9.** Implemented: `version`, `init`, `status`, `check`, `stage` (clone/worktree,
> uncommitted-change rescue, patches with a reverse check, install with stale-layout retry,
> build, `--resume` after a build in an administrator console, isolated `DSH_HOME` smoke,
> staged record, single-writer lock), `apply`/`rollback`, `toggle`/`start`/`stop`,
> `shortcuts`, `doctor`, `patch list|verify|add|remove`, the `tray` companion, the `task`
> watcher (it prepares a version; it never switches to it), the bundled `opencode-session`
> plugin, `setup.cmd`, and the green zip. `log` is listed by `--help` and exits `5` until its
> milestone lands.

## Who this is for

People who run DeepSeek Harness **from source** on Windows (Node, pnpm, PowerShell 7) and
want to follow upstream release tags without breaking the instance they are using.

**Not** a DSH installer: it does not install Node/pnpm, and it does not create the harness
checkout. It upgrades a checkout that already exists.

## What it does

Two slot checkouts (`slots\a`, `slots\b`) sit behind one stable path
(`…\deepseek-harness`, a junction). The serving slot is **read-only** during an upgrade:

1. `check` — fetch tags, compare strictly by semver (never downgrade).
2. `stage` — prepare the **spare** slot: check out the tag, install, build, smoke-test it on
   a spare port with an isolated `DSH_HOME`.
3. `apply` — stop the server, flip the junction, start, probe, and **roll back automatically**
   when startup fails.

`apply` and `rollback` always run as a detached helper process: the tool may be running
inside the very server it is replacing, so it must never do this work in-process.

The bundled `x-opencode-session` support installs with `setup`, so `opencode-go` requests
carry the header the gateway expects — no source patch, and it survives every upgrade.

## Prerequisites

| Requirement | Why |
|---|---|
| Windows 10/11 | junction-based switching and the scheduled task are Windows-specific |
| Node.js ≥ 24 | the tool runs from TypeScript sources (native type stripping) |
| PowerShell 7 (`pwsh`) | engine scripts and the tray companion |
| git | slot checkouts are `git worktree`s |
| pnpm | builds the staged version |

`doctor` probes all of this, plus long paths, free ports, disk space, and whether this
machine's protection software forces builds into an administrator console.

## Command surface

```
dsh-upgrade init [--root <dir>] [--upstream <url>] [--force]
dsh-upgrade status | check | stage | apply | rollback | toggle | start | stop
dsh-upgrade doctor [--fix]
dsh-upgrade opencode-session [install|remove|status] [--dry-run]
dsh-upgrade patch list | verify | add | remove
dsh-upgrade shortcuts [--install|--remove]
dsh-upgrade tray [--dry-run]
dsh-upgrade task [install|remove|status|run] [--interval <min>] [--s4u] [--dry-run]
dsh-upgrade log [--tail <n>] [--file <name>] [--list]
```

Every command accepts `--json` and `--config <path>`. Full reference:
[docs/commands.md](docs/commands.md).

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `2` | usage error (unknown command, bad arguments) |
| `3` | needs a human (for example: the build must run from an administrator console) |
| `4` | an environment probe failed |
| `5` | reserved: a command in the surface that is not implemented |

## Development

```powershell
node src/cli.ts --help      # run from sources (Node ≥ 24)
npm test                    # node --test
npm run typecheck           # tsc --noEmit (dev dependency)
node scripts/package.mjs    # build dist/dsh-upgrade-<version>.zip
```

## Documentation

| Document | Read it when |
|---|---|
| [quick-start](docs/quick-start.md) | installing the zip and doing the first upgrade |
| [commands](docs/commands.md) | you need a flag, a JSON field, or an exit code |
| [design](docs/design.md) | you are changing the tool, or wondering why a rule exists |
| [troubleshooting](docs/troubleshooting.md) | something failed |
| [patch-tracks](docs/patch-tracks.md) | writing, verifying, or retiring a source patch |
| [distribution](docs/distribution.md) | building or installing a release, migrating from the legacy scripts |
| [opencode-session](docs/opencode-session.md) | the gateway session header, and its settings |
| [decisions](docs/decisions/0001-no-windows-service.md) | why nothing is a Windows service, and why there is no `dsh` shim |

On Windows the tool is the only writer of the spare slot and the only process that flips the
stable-path junction.

## License

MIT — see [LICENSE](LICENSE). The bundled `plugins/opencode-session` is a vendored copy of
`dsh-x-opencode-session` by Coco-king (MIT); see its `NOTICE.md`.




