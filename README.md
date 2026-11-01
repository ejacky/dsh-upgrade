# dsh-upgrade

Short-restart upgrades for a **DeepSeek Harness source checkout** on Windows and Linux.

> **Status: v1.** Every command `--help` lists is implemented: `init`, `status`, `check`,
> `stage` (clone or worktree, uncommitted-change rescue, patches with a reverse check, install
> with stale-layout retry, build, `--resume` after a build in an administrator console,
> isolated `DSH_HOME` smoke test, staged record, single-writer lock), `apply`/`rollback`,
> `toggle`/`start`/`stop`, `shortcuts`, `doctor`, `patch list|verify|add|remove`,
> `tray` (Windows only), `task install|remove|status|run`,
> `log`, and `version`. It ships as a green zip on Windows and a tarball on Linux.

## Who this is for

People who run DeepSeek Harness **from source** (Node, pnpm) and want to follow upstream
release tags without breaking the instance they are using.

**Not** a DSH installer: it does not install Node/pnpm, and it does not create the harness
checkout. It upgrades a checkout that already exists.

## What it does

Two slot checkouts (`slots/a`, `slots/b`) sit behind one stable path
(`…/deepseek-harness`, a junction on Windows and a symlink elsewhere). The serving slot is
**read-only** during an upgrade:

1. `check` — fetch tags, compare strictly by semver (never downgrade).
2. `stage` — prepare the **spare** slot: check out the tag, install, build, smoke-test it on
   a spare port with an isolated `DSH_HOME`.
3. `apply` — flip the link, stop the old server, start the new one, probe it, and **roll
   back automatically** when startup fails.

`apply` runs as a detached helper process: the tool may be running inside the very server it
is replacing, so it must never flip the link in its own process. `rollback` is small
enough to run in the foreground under the same lock.

`opencode-go` requests carry the gateway's `x-opencode-session` header because the harness
sends it itself (pi-ai ≥ 1.3.0). The bundled plugin that used to add it is retired; a checkout
older than that needs one upgrade before the gateway will answer (see
[decisions/0004](docs/decisions/0004-retire-opencode-session-plugin.md)).

## Prerequisites

| Requirement | Why |
|---|---|
| Windows 10/11 **or** Linux | the stable path is a junction on Windows and an atomic symlink swap elsewhere |
| Node.js ≥ 24 | the tool runs from TypeScript sources (native type stripping) |
| git | slot checkouts are `git worktree`s |
| pnpm | builds the staged version |
| PowerShell 7 (`pwsh`) | **Windows only**: the tray, the `.lnk` launchers, and Task Scheduler registration |
| systemd user session | **Linux only**: the `task` watcher is a user timer; everything else works without it |

`doctor` probes all of this, plus free ports, disk space, and — on Windows — long paths and
whether this machine's protection software forces builds into an administrator console.

## Platform differences

| Surface | Windows | Linux |
|---|---|---|
| Stable path | directory junction | symlink, replaced with `rename(2)` so it never disappears |
| Stopping the server | `taskkill /T /F` | `SIGTERM`, then `SIGKILL` for the process group |
| "Is the port free?" | the `netstat` listener table | the `/proc` listener table, then a bind probe |
| Watcher | Task Scheduler entry (`task install`) | systemd user timer (`task install`) |
| Launchers | `.cmd` + `.vbs` + desktop `.lnk` | `.desktop` entries in the application menu |
| Tray | `engine-ps/tray.ps1` | not available; `tray` exits `3` and points at the launchers |
| Installer | `setup.cmd` | `setup.sh` |
| Release artifact | `dsh-upgrade-<version>.zip` | `dsh-upgrade-<version>.tar.gz` |

## Command surface

```
dsh-upgrade init [--root <dir>] [--upstream <url>] [--force]
dsh-upgrade status | check | stage | apply | rollback | toggle | start | stop
dsh-upgrade doctor [--fix]
dsh-upgrade patch list | verify | add | remove
dsh-upgrade shortcuts [--install|--remove]
dsh-upgrade tray [--dry-run]                  (Windows only)
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

```sh
node src/cli.ts --help      # run from sources (Node ≥ 24)
npm test                    # node --test
npm run typecheck           # tsc --noEmit (dev dependency)
node scripts/package.mjs    # build dist/dsh-upgrade-<version>.zip (Windows) or .tar.gz (Linux)
```

CI runs `typecheck` and `test` on `windows-latest` and `ubuntu-latest`. A change that only
works on one of them is not finished.

## Documentation

| Document | Read it when |
|---|---|
| [quick-start](docs/quick-start.md) | installing the release and doing the first upgrade |
| [commands](docs/commands.md) | you need a flag, a JSON field, or an exit code |
| [design](docs/design.md) | you are changing the tool, or wondering why a rule exists |
| [troubleshooting](docs/troubleshooting.md) | something failed |
| [patch-tracks](docs/patch-tracks.md) | writing, verifying, or retiring a source patch |
| [distribution](docs/distribution.md) | building or installing a release, migrating from the legacy scripts |
| [decisions](docs/decisions/) | why nothing is a service, why there is no `dsh` shim, and how Linux parity is scoped |

The tool is the only writer of the spare slot and the only process that flips the stable-path
link.

## License

MIT — see [LICENSE](LICENSE).
