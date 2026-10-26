# Quick start

`dsh-upgrade` keeps a DeepSeek Harness **source checkout** on Windows upgradeable: two slot
checkouts behind one stable-path junction, one version serving while the next is prepared.

## What you need

| Requirement | Why |
|---|---|
| Windows 10/11 | junction switching, the tray, and the scheduled task are Windows-specific |
| Node.js 24 or newer | the tool runs TypeScript directly through Node's type stripping |
| PowerShell 7 (`pwsh`) | the tray companion, shortcuts, and the scheduled task |
| git | slot checkouts are git worktrees/clones |
| pnpm | installs and builds the staged version |

`dsh-upgrade doctor` checks all of it, plus long paths, free ports, disk space, and whether this
machine refuses a child process the right to delete a large temporary file (which forces the
manual build flow).

## Install from the zip

1. Unpack `dsh-upgrade-<version>.zip` to a folder that can stay put (for example
   `E:\my\dsh-tools`).
2. Run `setup.cmd [root]` from that folder. `root` is the directory that will hold
   `deepseek-harness` (the stable path) and `dsh-slots`; it defaults to the folder above the
   tool.

`setup.cmd` runs `init`, `doctor`, `opencode-session install`, and `shortcuts --install`, and
stops at the first blocking problem. It never starts a background process on its own: installing
the scheduled watcher is a separate `task install`.

## First upgrade

```powershell
node E:\my\dsh-tools\src\cli.ts --config E:\my\dsh-tools\dsh-upgrade.json check   # is there a newer tag?
node E:\my\dsh-tools\src\cli.ts --config E:\my\dsh-tools\dsh-upgrade.json stage   # prepare the spare slot
node E:\my\dsh-tools\src\cli.ts --config E:\my\dsh-tools\dsh-upgrade.json apply   # switch to it
```

`stage` never touches the serving slot and `apply` rolls back by itself when the new version
does not start. `dsh-upgrade status` shows what is deployed, what is staged, and the last error.

## The two things people actually use

- **Tray**: `node …\src\cli.ts tray` (or the `DeepSeek Harness` desktop launcher) gives one icon
  with open / check / upgrade / rollback / logs / quit.
- **Scheduled watcher**: `… task install` checks every 20 minutes and prepares a new version. It
  never switches to it; the tray's **立即升级** applies what is staged.

## Where the state lives

```
<root>\dsh-upgrade.json          configuration (see commands.md)
<root>\deepseek-harness          junction to the serving slot
<root>\dsh-slots\a|b             the two checkouts
<root>\state\upgrade-state.json  deployed / staged / last error
<root>\state\layout.lock         one writer at a time
<root>\logs\                     stage, smoke, start, and watcher logs
<root>\rescued\                  uncommitted work rescued before a checkout
```

`dsh-upgrade log --list` shows the logs; `dsh-upgrade log --tail 80` prints the newest one.
