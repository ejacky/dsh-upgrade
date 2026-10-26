# Troubleshooting

Start with `dsh-upgrade doctor` and `dsh-upgrade log --tail 80`. Most failures leave a log line
that names the step.

## `stage` stops with exit 3

Exit `3` means a person has to decide something.

**"this machine builds only from an administrator console"** — `manualBuild` is on. Run the build
in an administrator console in that slot, then `dsh-upgrade stage --resume`. The tray does both
for you when you accept its prompt.

**"another layout action is running"** — `state\layout.lock` is held. Wait for the other action;
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

## The build fails with `Access is denied` or `EPERM` on a temp file

A protection driver is refusing a child process the right to delete a large temporary file. This
is not a permissions problem you can fix with ACLs.

1. `dsh-upgrade doctor` — the `protection-driver` probe reports it.
2. `dsh-upgrade doctor --fix` sets `manualBuild`.
3. Build from an administrator console (`stage`, then build, then `stage --resume`).

## `apply` fails and the service is down

It should not: a failed start restores the previous junction and restarts the previous server.
Check `dsh-upgrade status` for the recorded error and `dsh-upgrade log --file start.log`.

- **Port still held** — `stop` refuses to claim success while a pid still owns `webPort`; the
  port owner is in the message. Kill it (`taskkill /PID <pid> /T /F`) or change `webPort`.
- **New version answers nothing** — the smoke test passed on `smokePort` but the real start
  failed; read `start.log`. The deployed version is unchanged.

## `check` says a newer version exists but `stage` keeps preparing the same one

`stage` picks the newest matching tag unless `--tag` is given. If the workspace is offline, tags
come from the last fetch; `--no-fetch` avoids a failing fetch but cannot invent newer tags.

## The tray does not appear

- `dsh-upgrade tray --dry-run` prints the exact command; run it in a console to see the error.
- The companion needs PowerShell 7. `doctor` reports `powershell-7`.
- A second instance exits immediately with a message box; the tray is per session.
- A tray start with no configuration prints "run dsh-upgrade init".

## The scheduled task never runs

- `dsh-upgrade task status --json` — `installed`, `state`, `lastRun`, `lastResult`. A
  `lastResult` other than `0` is the watcher's exit code (`3` means staging needed a human).
- `logs\watch.log` records one line per pass.
- With the default principal the task runs **only while the account is logged on**. `task install
  --s4u` changes that, but S4U sessions have no network credentials, which can break the
  `git fetch`.
- `task install` may need an administrator console; the failure says so.

## `opencode-session install` fails

- "the DSH CLI was not found under the stable path" — no built harness is serving yet. `stage`
  and `apply` once, then install.
- "dsh plugin add failed" — read the message; the plugin manager's own diagnostics path is
  printed by `dsh`.
- The gateway still sees no header — check `doctor`'s `opencode-session` probe. It says whether
  the plugin is installed, whether the legacy provider `sessionHeader` is still present, and what
  the effective header and URL markers are.
- To undo: `opencode-session remove`. The profile patch was backed up as
  `cordis.patch.yml.bak-<timestamp>` before the first install.

## "stable path is a real directory"

The tool only replaces a link. If `<root>\deepseek-harness` is a real checkout somebody made by
hand, move it aside (or point `stablePath` somewhere else) and run `stage`/`apply` again. The tool
will never delete a real directory to make room for its link.

## The lock file, or a rescued patch, is in the way

- `state\layout.lock` — see above.
- `rescued\<slot>-<stamp>.patch` — uncommitted work that `stage` moved aside before a forced
  checkout. Inspect it (`git apply --stat`) and re-apply what matters; the tool never deletes
  these.

## PowerShell 7 is installed but not found

`shortcuts`, `tray`, `task`, and `doctor` call `pwsh`. Windows PowerShell 5.1 is not supported.
Install PowerShell 7 (`winget install Microsoft.PowerShell`) and make sure it is on `PATH`.
