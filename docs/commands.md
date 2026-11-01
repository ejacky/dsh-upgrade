# Commands

Every command accepts `--json` and `--config <path>`. Without `--config`, the configuration is
looked up through `$DSH_UPGRADE_CONFIG`, then the current directory, then the tool's own
directory.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `2` | usage error (unknown command or argument, bad value) |
| `3` | needs a human (build in an administrator console, patch conflict, lock held) |
| `4` | environment or probe failure (no configuration, no checkout, missing tool) |
| `5` | reserved for a command that is part of the surface but not implemented |

## Configuration (`dsh-upgrade.json`)

| Field | Default | Meaning |
|---|---|---|
| `root` | required | directory holding the stable path and the slots |
| `stablePath` | `<root>/deepseek-harness` | link that serves one slot (junction on Windows, symlink elsewhere) |
| `slotsRoot` | `<root>/dsh-slots` | the two checkouts |
| `upstream` | the DSH repository | git URL to follow |
| `tagPattern` | `dsh-v*` | which tags are releases |
| `webPort` | `3080` | port the serving app listens on |
| `smokePort` | `3099` | port a staged version is proven on |
| `manualBuild` | `false` | this machine only builds from an administrator console |
| `buildGateConcurrency` | `1` | gate parallelism for `pnpm run build` |
| `patchFiles` | `[]` | source patches applied to every staged slot |

## Layout and lifecycle

### `init [--root <dir>] [--upstream <url>] [--force]`
Creates the directories, the configuration, and an empty state file. `--force` rewrites an
existing configuration.

### `status`
Prints versions, slots, staged version, and the last error. `--json`: `{ok, configPath,
stablePath, activeSlot, deployed, staged, lastCheck, lastError, slots}`.

### `check [--no-fetch]`
Fetches tags and compares strictly by semver. `--json`: `{ok, current, latest, newer, candidate,
tags}`; when the check cannot run it emits `{ok: false, error, nextAction}` and exits `4`. A
candidate is only ever a strictly newer version; a re-tagged or older release is never proposed.

### `stage [--tag <tag>] [--skip-build] [--skip-install] [--force] [--no-fetch] [--resume]`
Prepares the **spare** slot: checkout the tag, rescue uncommitted work, apply patches, install,
build, smoke-test on `smokePort` with an isolated `DSH_HOME`, then record it as staged.

- A prepared slot is reused only when nothing would change: no patch is configured **and** the
  state still records that version in that slot as staged.
- `--tag` must match `tagPattern` and be strictly newer than the deployed version; a
  non-newer tag exits `3` unless `--force` is given. `--force` also skips the reuse shortcut.
- `manualBuild` stops after install, drops the slot's stale build record, writes
  `state/build-request.json`, and exits `3`.
- `--resume` finishes that build: it verifies the slot is still at the requested tag, requires a
  build record newer than the request, runs the smoke test, records the slot, and deletes the
  request.
- `--json` on success: `{ok, tag, slot, smoke, clientVersion, clientArtifacts,
  patches:{applied, alreadyApplied}, nextAction}`. The reuse shortcut emits
  `{ok, tag, slot, alreadyPrepared: true}`; `--resume` emits
  `{ok, resumed: true, tag, slot, smoke, nextAction}`.

### `apply [--wait] [--no-start]`
Flips the stable-path link to the staged slot, stops the old server, starts the new one, and waits
for it to answer. A failed start restores **and restarts** the previous slot, so the service keeps
serving. The slot must still be checked out at the staged tag; otherwise `apply` exits `4` and
records nothing. `--no-start` flips the link and leaves the running server alone.

By default `apply` detaches the switch and returns immediately — exit `0` means *scheduled*.
`--json` (detached): `{ok, detached: true, tag, slot, nextAction: "status"}`. With `--wait`
`--json` reports the outcome: `{ok, tag, slot, started}` or `{ok: false, error, nextAction}`.

### `rollback [--no-start]`
Switches back to the previously deployed slot under the same link rules, in the foreground
under the layout lock. `--json` is the same object `apply --wait` emits.

### `toggle [--yes]` / `start` / `stop`
One-icon control. `toggle` starts when the port is free and stops when it is held; stopping asks
for consent on a terminal (20 s deadline, silence means "keep running"). A desktop launcher has
no terminal: in a graphical session it asks in a dialog (the first of zenity, kdialog, yad, or
xmessage that is installed), and with none installed it exits `3` and says so. `--yes` skips the
question. `stop` only reports success when the port is actually free.

### `doctor [--fix]`
Probes configuration, Node 24, git, pnpm, both ports, disk space, the stable path, slot
writability, and whether the installed harness sends the gateway's session header itself
(`provider-session-header`; a warning, because the fix is a newer release, not a local setting).
On Windows it also probes PowerShell 7, long paths, and the protection driver; elsewhere it
reports whether a systemd user session answers (also a warning). `--fix` changes one thing: `manualBuild`;
`--json` reports `fixed` (an array) only when the flag was given. On a platform without the
protection-driver probe it prints that there is nothing to fix. Exit `4` when a blocking probe
fails.

### `patch list|verify|add|remove`
- `list [--manifest <path>]` — the catalog merged with `patchFiles`, with notes for a missing
  file, an obsolete patch, or a catalogued patch that is not applied.
- `verify [--all] [--slot a|b] [--manifest <path>]` — checks each patch against a real checkout in
  both directions: `applies`, `applied` (the tree already carries it), `conflict`, `missing`.
  Exit `3` when a *configured* patch needs a human.
- `add <name> | --file <path>` / `remove <name> | --file <path>` — edits only `patchFiles` in the
  raw configuration (unknown keys and path spellings survive, the write is atomic), and compares
  real paths so `.`-segments, short names, and letter case cannot duplicate an entry.

### `shortcuts [--install|--remove]`
Launchers for start/stop and update. On Windows they are hidden `wscript` wrappers written as
UTF-16LE so non-ASCII paths survive (the `.cmd` copies stay ASCII) plus desktop `.lnk` files; on
Linux they are `.desktop` entries in `$XDG_DATA_HOME/applications` (default
`~/.local/share/applications`) with `Icon=` names backed by SVGs installed under
`$XDG_DATA_HOME/icons/hicolor/scalable/apps`. The start/stop entry runs `toggle` without
`--yes`, so it asks before acting. There is no tray entry on Linux because there is no tray.

### `tray [--dry-run]`
Runs the PowerShell 7 tray companion (Windows). `--dry-run` prints the exact command, which is
the fastest way to see why a launcher does nothing; it is a Windows-only path. On Linux `tray`
exits `3` and points at `shortcuts` and `toggle`: the capability is absent, and a companion that
silently does nothing would be worse.

### `task install|remove|status|run [--interval <min>] [--s4u] [--dry-run] [--name <task>]`
The watcher. `install` registers a periodic job (default `DshUpstreamUpgrade`, every 20 minutes,
minimum 5); `status` reports what is registered; `run` performs one pass: `check`, then `stage`
when a newer tag exists. It never applies.

- **Windows** — a hidden `wscript` wrapper in Task Scheduler. `status` reads the cmdlet objects
  rather than localized `schtasks` text. `--s4u` runs whether or not the account is logged on.
- **Linux** — `$XDG_CONFIG_HOME/systemd/user/<name>.{service,timer}` (default
  `~/.config/systemd/user`), enabled with `systemctl --user enable --now`. `status --json`
  reports `installed`, `state`, `subState`, `lastRun`/`nextRun` (ISO 8601), `lastResult` (the
  service's exit status, `null` before the first run), `logonType: "systemd-user"`,
  `intervalMinutes`, and `unit` (the timer's path). `--s4u` is rejected with exit `2`;
  `--dry-run --json` returns `serviceUnitText`, `timerUnitText`, `unit`, and `registration`
  without writing anything.
- Both platforms write `logs/watch.log`, one line per pass.

### `log [--tail <n>] [--file <name|path>] [--list]`
Prints the tail of a log file (default: the newest, 40 lines) or lists what exists.

### `version`
Prints the tool version; `--version` does the same.
