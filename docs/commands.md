# Commands

Every command accepts `--json` and `--config <path>`. Without `--config`, the configuration is
looked up in the current directory, then in the tool's own directory, then `$DSH_UPGRADE_CONFIG`.

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
| `stablePath` | `<root>\deepseek-harness` | junction that serves one slot |
| `slotsRoot` | `<root>\dsh-slots` | the two checkouts |
| `upstream` | the DSH repository | git URL to follow |
| `tagPattern` | `dsh-v*` | which tags are releases |
| `webPort` | `3080` | port the serving app listens on |
| `smokePort` | `3099` | port a staged version is proven on |
| `profile` | `web` | DSH profile the plugin installs into |
| `manualBuild` | `false` | this machine only builds from an administrator console |
| `buildGateConcurrency` | `1` | gate parallelism for `pnpm run build` |
| `opencodeSession` | `{enabled: true, source: "builtin", header: "x-opencode-session", urlMarkers: ["opencode.ai"]}` | gateway header policy |
| `patchFiles` | `[]` | source patches applied to every staged slot |

## Layout and lifecycle

### `init [--root <dir>] [--upstream <url>] [--force]`
Creates the directories, the configuration, and an empty state file. `--force` rewrites an
existing configuration.

### `status`
`--json`: `{deployed, staged, activeSlot, slots, lastCheck, lastError, served}`.

### `check [--no-fetch]`
Fetches tags and compares strictly by semver. `--json`: `{ok, current, latest, newer, candidate,
tags}`. A candidate is only ever a strictly newer version; a re-tagged or older release is never
proposed. Exit `4` when the fetch or the checkout cannot be read.

### `stage [--tag <tag>] [--skip-build] [--skip-install] [--force] [--no-fetch] [--resume]`
Prepares the **spare** slot: checkout the tag, rescue uncommitted work, apply patches, install,
build, smoke-test on `smokePort` with an isolated `DSH_HOME`, then record it as staged.

- A prepared slot is reused only when no patch is configured (a new patch must be applied).
- `manualBuild` stops after install, writes `state\build-request.json`, and exits `3`.
- `--resume` finishes that build: it verifies the slot is still at the requested tag, requires
  the `.dsh-build` record, runs the smoke test, records the slot, and deletes the request.
- `--json`: `{ok, tag, slot, smoke, clientVersion, clientArtifacts, patches:{applied, alreadyApplied},
  alreadyPrepared?, nextAction}`.

### `apply [--wait] [--no-start]`
Switches the junction to the staged slot, stops the server, starts the new one, and waits for it
to answer. A failed start restores **and restarts** the previous slot, so the service keeps
serving. `apply` always runs as a detached helper; `--wait` keeps it in the foreground for tests.
`--json`: `{ok, to, from, started, error?}`.

### `rollback [--no-start]`
Switches back to the previously deployed slot under the same rules as `apply`.

### `toggle [--yes]` / `start` / `stop`
One-icon control. `toggle` starts when the port is free and stops when it is held; stopping asks
for consent on a terminal (20 s deadline, silence means "keep running") and needs `--yes`
otherwise. `stop` only reports success when the port is actually free.

### `doctor [--fix]`
Probes configuration, PowerShell 7, Node 24, git, pnpm, long paths, both ports, disk space, the
protection driver, the stable path, slot writability, and which mechanism provides the gateway
session header. `--fix` changes one thing: `manualBuild`. Exit `4` when a blocking probe fails.

### `patch list|verify|add|remove`
- `list [--manifest <path>]` — the catalog merged with `patchFiles`, with notes for a missing
  file, an obsolete patch, or a catalogued patch that is not applied.
- `verify [--all] [--slot a|b] [--manifest <path>]` — checks each patch against a real checkout in
  both directions: `applies`, `applied` (the tree already carries it), `conflict`, `missing`.
  Exit `3` when a *configured* patch needs a human.
- `add <name> | --file <path>` / `remove <name> | --file <path>` — edits only `patchFiles` in the
  raw configuration (unknown keys and path spellings survive, the write is atomic), and compares
  real paths so `.`-segments, short names, and letter case cannot duplicate an entry.

### `opencode-session install|remove|status [--dry-run]`
Installs the bundled gateway-header plugin into the DSH profile, removes a provider
`sessionHeader` left over from the patched-source era (the profile patch is backed up first), and
writes a settings override only when the configuration differs from the plugin defaults. See
[opencode-session.md](opencode-session.md).

### `shortcuts [--install|--remove]`
Desktop launchers for start/stop, update, and the tray. The wrappers are hidden `wscript` files
written as UTF-16LE so non-ASCII paths survive; the `.cmd` copies stay ASCII.

### `tray [--dry-run]`
Runs the PowerShell 7 tray companion. `--dry-run` prints the exact command, which is the fastest
way to see why a launcher does nothing.

### `task install|remove|status|run [--interval <min>] [--s4u] [--dry-run] [--name <task>]`
The scheduled watcher. `install` registers a hidden `wscript` wrapper (default `DshUpstreamUpgrade`,
every 20 minutes, minimum 5); `status` reads the Task Scheduler objects rather than localized
`schtasks` text; `run` performs one pass: `check`, then `stage` when a newer tag exists. It never
applies.

### `log [--tail <n>] [--file <name|path>] [--list]`
Prints the tail of a log file (default: the newest, 40 lines) or lists what exists.

### `version`
Prints the tool version; `--version` does the same.
