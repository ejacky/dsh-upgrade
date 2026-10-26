# dsh-upgrade

Zero-downtime upgrades for a **DeepSeek Harness source checkout** on Windows.

> **Status: M1.** Implemented: `version`, `init`, `status`, `check` (configuration, state,
> strict semver ordering, real tag fetching, junction-aware slot resolution). Remaining v1
> commands are listed by `--help` and exit with `5` (not implemented) until their milestone
> lands.

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
dsh-upgrade init [--root <dir>] [--upstream <url>] [--tag <tag>]
dsh-upgrade status | check | stage | apply | rollback | toggle | start | stop
dsh-upgrade doctor [--live]
dsh-upgrade opencode-session [install|remove|status|disable]
dsh-upgrade patch list | verify | add | remove
dsh-upgrade shortcuts [--install|--remove]
dsh-upgrade tray
dsh-upgrade task [install|remove|status] [--interval <min>] [--s4u]
dsh-upgrade log [--tail <n>]
```

Every command accepts `--json`.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `2` | usage error (unknown command, bad arguments) |
| `3` | needs a human (for example: the build must run from an administrator console) |
| `4` | an environment probe failed |
| `5` | command not implemented yet |

## Development

```powershell
node src/cli.ts --help      # run from sources (Node ≥ 24)
npm test                    # node --test
npm run typecheck           # tsc --noEmit (dev dependency)
```

On Windows the tool is the only writer of the spare slot and the only process that flips the
stable-path junction. See `docs/design.md` (added in M10) for the invariants and the reasons
behind them.

## License

MIT — see `LICENSE`.

