# Quick start

`dsh-upgrade` keeps a DeepSeek Harness **source checkout** upgradeable: two slot checkouts
behind one stable-path link, one version serving while the next is prepared.

## What you need

| Requirement | Why |
|---|---|
| Windows 10/11 or Linux | the stable path is a junction on Windows and a symlink elsewhere; the watcher is Task Scheduler or a systemd user timer |
| Node.js 24 or newer | the tool runs TypeScript directly through Node's type stripping |
| git | slot checkouts are git worktrees/clones |
| pnpm | installs and builds the staged version |
| PowerShell 7 (`pwsh`) — Windows only | the tray companion, `.lnk` shortcuts, and Task Scheduler registration |
| a systemd user session — Linux only | `task install`; every other command works without it |

`dsh-upgrade doctor` checks all of it, plus free ports and disk space. On Windows it also probes
long paths and whether the machine refuses a child process the right to delete a large temporary
file (which forces the manual build flow); on Linux it reports whether the systemd user session
answers.

## Install

**Windows** — unpack `dsh-upgrade-<version>.zip` to a folder that can stay put (for example
`E:\my\dsh-tools`), then run `setup.cmd [root]`.

**Linux** — unpack `dsh-upgrade-<version>.tar.gz` to a folder that can stay put (for example
`/opt/dsh-tools`), then run `sh setup.sh [root]`.

`root` is the directory that will hold `deepseek-harness` (the stable path) and `dsh-slots`; it
defaults to the folder above the tool. The installer runs `init`, `doctor`, and
`shortcuts --install`, and stops at the first blocking problem.
It never starts a background process on its own: installing the watcher is a separate
`task install`.

## First upgrade

Windows:

```powershell
node E:\my\dsh-tools\src\cli.ts --config E:\my\dsh-tools\dsh-upgrade.json check   # is there a newer tag?
node E:\my\dsh-tools\src\cli.ts --config E:\my\dsh-tools\dsh-upgrade.json stage   # prepare the spare slot
node E:\my\dsh-tools\src\cli.ts --config E:\my\dsh-tools\dsh-upgrade.json apply   # switch to it
```

Linux:

```sh
node /opt/dsh-tools/src/cli.ts --config /opt/dsh-tools/dsh-upgrade.json check
node /opt/dsh-tools/src/cli.ts --config /opt/dsh-tools/dsh-upgrade.json stage
node /opt/dsh-tools/src/cli.ts --config /opt/dsh-tools/dsh-upgrade.json apply
```

`stage` never touches the serving slot and `apply` rolls back by itself when the new version
does not start. `dsh-upgrade status` shows what is deployed, what is staged, and the last error.

## The two things people actually use

- **Launchers**: `shortcuts --install` puts a start/stop entry and an update entry where the
  platform expects them — desktop shortcuts on Windows (plus one for the tray), application-menu
  `.desktop` entries on Linux.
- **Tray** (Windows): `dsh-upgrade tray` gives one icon with open / check / upgrade / rollback /
  logs / quit. Linux has no tray companion; `tray` says so and exits `3`.
- **Watcher**: `task install` checks every 20 minutes and prepares a new version. It never
  switches to it; the launcher's update entry (or `apply`) installs what is staged.

## Where the state lives

```
<tool>/dsh-upgrade.json          configuration, written beside the tool by setup (--config overrides)
<root>/deepseek-harness          link to the serving slot
<root>/dsh-slots/a|b             the two checkouts
<root>/state/upgrade-state.json  deployed / staged / last error
<root>/state/layout.lock         one writer at a time
<root>/logs/                     stage, smoke, start, and watcher logs
<root>/rescued/                  uncommitted work rescued before a checkout
```

Windows accepts `\` in these paths; the layout is the same.

`dsh-upgrade log --list` shows the logs; `dsh-upgrade log --tail 80` prints the newest one.
