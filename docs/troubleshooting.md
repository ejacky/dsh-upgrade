# Troubleshooting

Start with `dsh-upgrade doctor` and `dsh-upgrade log --tail 80`. Most failures leave a log line
that names the step.

## `stage` stops with exit 3

Exit `3` means a person has to decide something.

**"this machine builds only from an administrator console"** — `manualBuild` is on. Run the build
in an administrator console in that slot, then `dsh-upgrade stage --resume`. The tray does both
for you when you accept its prompt.

**"another layout action is running"** — `state/layout.lock` is held. Wait for the other action;
a lock whose process is gone is reclaimed at once, and one that is still held is reclaimed only
after 24 hours. To reclaim earlier, delete the file after confirming no `stage`/`apply` is
running.

**"<patch> does not apply to <tag>"** — the patch needs a rebase. `dsh-upgrade patch verify`
shows every patch's state; `dsh-upgrade patch remove <name>` drops one; a rebased file goes back
through `patch add`.

## `pnpm install` fails or hangs

- The tool runs install with a non-interactive stdin and `CI=1`, so a prompt cannot hang it; a
  timeout kills the process tree and reports the tail.
- "modules directories will be removed and reinstalled" prompts used to hang this step; if a
  hand-run install asks, answer yes — the next `stage` will use the clean layout.
- A stale layout (`node_modules` created under a different path spelling) is detected, removed,
  and retried once.

## The build fails with `Access is denied` or `EPERM` on a temp file (Windows)

A protection driver is refusing a child process the right to delete a large temporary file. This
is not a permissions problem you can fix with ACLs.

1. `dsh-upgrade doctor` — the `protection-driver` probe reports it.
2. `dsh-upgrade doctor --fix` sets `manualBuild`.
3. Build from an administrator console (`stage`, then build, then `stage --resume`).

On Linux there is no such probe; `doctor --fix` says there is nothing to fix.

## `apply` fails and the service is down

It should not: a failed start restores the previous link and restarts the previous server.
Check `dsh-upgrade status` for the recorded error and `dsh-upgrade log --file start.log`.

- **Port still held** — `stop` refuses to claim success while a pid still owns `webPort`; the
  port owner is in the message. End it (`taskkill /PID <pid> /T /F` on Windows, `kill <pid>` on
  Linux) or change `webPort`. On Linux the message says "cannot identify" when the listener
  belongs to another account and neither `/proc`, `ss`, nor `lsof` could name it; then find it
  with `sudo ss -ltnp 'sport = :<port>'`.
- **New version answers nothing** — the smoke test passed on `smokePort` but the real start
  failed; read `start.log`. The deployed version is unchanged.

## `check` says a newer version exists but `stage` keeps preparing the same one

`stage` picks the newest matching tag unless `--tag` is given. If the workspace is offline, tags
come from the last fetch; `--no-fetch` avoids a failing fetch but cannot invent newer tags.

## The tray does not appear

The tray companion is Windows-only; on Linux `tray` exits `3` and points at `shortcuts`.

- `dsh-upgrade tray --dry-run` (Windows) prints the exact command; run it in a console to see
  the error. On Linux `tray` exits `3` before any dry run.
- The companion needs PowerShell 7. `doctor` reports `powershell-7` on Windows.
- A second instance exits immediately with a message box; the tray is per session.
- A tray start with no configuration prints "run dsh-upgrade init".
- On Linux, use `toggle` or the `.desktop` launchers from `shortcuts --install`. A launcher
  asks before starting or stopping; if no dialog tool is installed (zenity, kdialog, yad, or
  xmessage), it exits `3` and says so — install one, or run `toggle --yes`.

## The watcher never runs

- `dsh-upgrade task status --json` — `installed`, `state`, `lastRun`, `lastResult`. On Windows
  `lastResult` is Task Scheduler's last-run result; the `.vbs` wrapper does not pass the
  watcher's exit code back, so read `logs/watch.log` to see whether a pass failed (`3` means
  staging needed a human). On Linux it is the service's `ExecMainStatus`.
- `logs/watch.log` records one line per pass.
- On Windows, with the default principal the task runs **only while the account is logged on**.
  `task install --s4u` changes that, but S4U sessions have no network credentials, which can break
  the `git fetch`.
- On Linux, `task install` writes `$XDG_CONFIG_HOME/systemd/user/<name>.{service,timer}` — with
  the default name, `~/.config/systemd/user/DshUpstreamUpgrade.{service,timer}` — and enables the
  timer. `systemctl --user status DshUpstreamUpgrade.timer` and
  `journalctl --user -u DshUpstreamUpgrade.service` are the two places to look.
- A systemd user timer stops when the last session ends. `loginctl enable-linger "$USER"` keeps
  it running while logged out; `task status` reports the state it finds.
- Without a systemd user session, `task install` exits `3`; `task install --dry-run` prints the
  unit texts and the command a cron entry would have to reproduce, and leaves no unit behind.
- `task install` may need an administrator console on Windows; the failure says so.

## `systemctl --user` does not answer on Linux

`doctor` reports this as `systemd-user` (a warning, not a blocking failure). Only `task` needs
it; `stage`, `apply`, and `rollback` work in a container or over a bare SSH session. Run
`systemctl --user status` to see why; a missing `DBUS_SESSION_BUS_ADDRESS` is the usual cause.

## The gateway rejects `opencode-go` requests on an old checkout

The `x-opencode-session` header comes from the harness (pi-ai 1.3.0 and newer). `doctor`'s
`provider-session-header` probe reads the installed build: if it reports that the build does not
add the header, `stage` and `apply` a newer release. There is no plugin to install any more;
[decision 0004](decisions/0004-retire-opencode-session-plugin.md) explains why.

## "stable path is a real directory"

The tool only replaces a link. If `<root>/deepseek-harness` is a real checkout somebody made by
hand, move it aside (or point `stablePath` somewhere else) and run `stage`/`apply` again. The tool
will never delete a real directory to make room for its link.

## The lock file, or a rescued patch, is in the way

- `state/layout.lock` — see above.
- `rescued/<slot>-<stamp>.patch` — uncommitted work that `stage` moved aside before a forced
  checkout. Inspect it (`git apply --stat`) and re-apply what matters; the tool never deletes
  these.

## PowerShell 7 is installed but not found (Windows)

`shortcuts`, `tray`, `task`, and `doctor` call `pwsh` on Windows. Windows PowerShell 5.1 is not
supported. Install PowerShell 7 (`winget install Microsoft.PowerShell`) and make sure it is on
`PATH`. On Linux none of these commands call `pwsh`.
