# AGENTS.md

`dsh-upgrade` upgrades a **DeepSeek Harness source checkout** on Windows and Linux with two slot
checkouts (`<root>/dsh-slots/a|b`) behind one stable-path link (a junction on Windows, a symlink
elsewhere). It also ships a tray companion (Windows) and a watcher (Task Scheduler or a systemd
user timer).

Read [docs/design.md](docs/design.md) before changing anything under `src/engine/`; it explains
the invariants below and why they exist. [docs/commands.md](docs/commands.md) owns the command,
flag, exit-code, and JSON contract; [docs/troubleshooting.md](docs/troubleshooting.md) owns the
failure symptoms.

## Commands

```sh
node src/cli.ts --help        # run from sources; Node 24 strips the types, there is no build step
node src/cli.ts doctor        # probe this machine before blaming a code change
npm run typecheck             # tsc --noEmit (strict; see tsconfig.json)
npm test                      # node --test, all offline (~30 s per platform)
node --test tests/apply.test.ts   # one file while iterating
node scripts/package.mjs --dry-run   # what the release archive would contain
node scripts/package.mjs             # dist/dsh-upgrade-<version>.zip (Windows) or .tar.gz (Linux)
```

CI (`.github/workflows/ci.yml`) runs `npm install`, `npm run typecheck`, and `npm test` on
`windows-latest` and `ubuntu-latest`. Both are the gate for landing a change, so run them locally
first.

## Layout

```
src/cli.ts            command table, global flags, exit codes, help
src/commands/*.ts     one file per command; it parses its own flags and prints its own output
src/engine/*.ts       the layout, state, locks, git, pnpm, service, smoke test, patches, config
src/engine/host.ts    the platform seam: ports, process tree, links, launcher/unit dirs, spawn
src/version.ts        reads version.json
engine-ps/tray.ps1    the tray companion (PowerShell 7 + WinForms, Windows only)
patches/manifest.json the patch catalog (empty by default)
scripts/package.mjs   builds the green zip (Windows) or tarball (Linux)
setup.cmd             ASCII-only one-shot installer for an unpacked Windows release
setup.sh              POSIX sh one-shot installer for an unpacked Linux release
docs/                 quick-start, commands, design, troubleshooting, patch-tracks,
                      distribution, decisions/
tests/*.test.ts       one file per surface: most spawn the real CLI; primitives are unit-tested.
                      A platform split may add a second file (task.linux.test.ts)
tests/helpers/        the one place that decides which platform's assertions can run
```

## Invariants

A change must keep all of these. Each one is enforced by a guard or a test; if a guard has to
move, move its test with it.

1. **Never write the serving slot.** `stage` writes only `spareSlot()`; it refuses a slot outside
   `slotsRoot`, the active slot, a real directory at `stablePath`, and a machine where `webPort`
   is served but the link does not identify a slot.
2. **Never leave the machine serving nothing.** A failed switch restores the previous link
   *and* restarts the previous server. `apply --no-start` flips the link and leaves the
   running server alone.
3. **Never report an effect you did not observe.** `stop` waits for the port, `apply` waits for a
   URL that the process it started answers, `stage` smoke-tests the built entry, and `task install`
   re-queries the task.
4. **One writer at a time.** `stage`, `apply --wait`, the detached `apply` worker, and `rollback`
   take `state/layout.lock`. `acquireLock` publishes atomically; a live owner is never evicted.
5. **Versions only move forward.** `check` proposes strictly newer tags; `stage --tag` refuses a
   non-newer tag unless `--force`; `apply` refuses a slot that is no longer at the staged tag.
6. **Deletes never follow a link.** `removeTree` resolves the root, unlinks links, and refuses
   paths outside the allowed roots.
7. **Uncommitted work is rescued first.** `ensureCheckout` writes tracked changes to
   `rescued/<slot>-<stamp>.patch` and copies untracked entries next to it before any
   `checkout --force`; a failing `git status` aborts instead of proceeding.
8. **`apply` never runs inside the process it replaces.** The default path spawns a detached
   worker through `cliEntryPath()`; `--wait` exists for tests and for an operator who wants the
   output.
9. **A configured patch that does not apply fails the stage.** Never ship a tree with a
   half-applied patch set.
10. **Every failure exits `0/2/3/4` with one line, never a stack trace.** `cli.ts` catches at the
    top level; a command that can fail must report through its own JSON/stderr path.
11. **A platform capability that is missing fails loudly.** `tray` on Linux exits `3` and points
    at the launchers; `task install` without a systemd user session exits `3` and points at
    `task install --dry-run`, which prints the units such a machine would have to run itself. No
    command may silently degrade into doing nothing.

## Code conventions

- **ESM and TypeScript only.** Relative imports carry `.ts`. `verbatimModuleSyntax` means type
  imports need `import type`. `erasableSyntaxOnly` forbids enums, namespaces, and constructor
  parameter properties.
- **`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on.** Read array elements as
  `possibly undefined`; build optional properties with conditional spread (`...x === undefined ?
  {} : { x }`), never with `undefined` values.
- **`noUnusedLocals` / `noUnusedParameters` are on.** Prefix an intentionally unused parameter
  with `_`.
- **Every module and export has JSDoc that states the contract**, including `@param`/`@returns`
  for function-like exports. Keep comments local: explain the failure mode a reader would get
  wrong, not the control flow.
- **No runtime dependencies.** The tool runs from sources with Node 24; a dependency would have to
  justify itself against that and against the offline install.
- **Errors are structured and actionable.** Name the file or value, say what to do next, and use
  the documented exit code (`2` usage, `3` needs a human, `4` environment).
- **JSON output is a compatibility promise.** The tray and the watcher parse it; adding a field
  is fine, renaming one is a breaking change that needs a docs update and a test.

### Adding or changing a command

1. Put the implementation in `src/commands/<name>.ts`, exporting one `run<Name>` that returns the
   exit code (async only when it must await a server).
2. Add it to the `COMMANDS` table in `src/cli.ts` with a summary, a usage hint, and
   `implemented: true`.
3. Support `--json` on every path, including failures (`{ok: false, error, nextAction}`).
4. Add a test file that spawns `src/cli.ts` and asserts exit codes and JSON, not internals.
5. Update `docs/commands.md` (the flag and JSON contract) and, if behaviour changed,
   `docs/troubleshooting.md`.

## Platform specifics

Everything that differs between the platforms belongs in `src/engine/host.ts` (port owner,
process tree, link swap, launcher/unit directories, child process group, pnpm executable); a
command must not branch on `process.platform`. Four exceptions exist and are deliberate, because
their *output* differs rather than a capability: the `tray` capability guard, the `doctor` probe
list, the Task Scheduler/systemd renderers in `task`, and the `.lnk`/`.desktop` renderers in
`shortcuts`.

### Windows

- `.cmd` files are **pure ASCII** (`cmd.exe` reads them in the console code page). A launcher
  `.cmd` is a trampoline to its sibling `.vbs` through `%~dp0`, so it never embeds a path.
- `.vbs` files are **UTF-16LE with a BOM** and double their quotes: `wscript` then survives a
  non-ASCII path.
- `.ps1` files are UTF-8; `tray.ps1` is read by PowerShell 7, which handles that without a BOM.
- `Start-Process -ArgumentList` does not quote elements: pass paths through
  `ConvertTo-Argument` in PowerShell, and build argv arrays in Node.
- Inside a batch `if (...)` block, read variables as `!NAME!`; `%NAME%` is expanded before cmd
  parses the block, so a path with `&` or parentheses breaks it.
- Long paths, junctions, and a `OneDrive`-redirected Desktop are the defaults this code meets:
  resolve the Desktop with `[Environment]::GetFolderPath('Desktop')`, and create junctions with
  `fs.symlinkSync(target, path, 'junction')`.
- The server is stopped with `taskkill /T /F`; the port owner comes from `netstat -ano`.

### Linux

- The stable path is a symlink, replaced by writing a temporary symlink and renaming it over the
  old one. Never unlink first: the stable path must not be missing even for a moment.
- A child that may need to be killed as a tree is spawned with `detached: true`, so its children
  share a process group and `process.kill(-pid, ...)` reaches them. A child spawned without it can
  only be killed directly.
- Port ownership comes from `/proc/net/tcp{,6}` and `/proc/<pid>/fd`, with `ss` and `lsof` only
  as fallbacks. A port is free when `/proc` lists no listener for it and no bind refuses with
  `EADDRINUSE`; the owner lookup alone is not an answer, because it cannot see another account's
  socket.
- The watcher is a systemd **user** timer under `$XDG_CONFIG_HOME/systemd/user` (default
  `~/.config/systemd/user`). Tests must never call `systemctl`: render units with `--dry-run`.
- Launchers are `.desktop` entries under `$XDG_DATA_HOME/applications`; `setup.sh` is POSIX sh and
  ASCII only. There is no tray: `tray` exits `3` and points at the launchers.

## Testing

- **Offline and self-contained.** Every test builds its own fixture under the platform temp
  directory and deletes nothing outside it. No test may touch the real `~/.dsh`: pass `DSH_HOME`
  at a temp directory; for the watcher, pass `XDG_CONFIG_HOME` the same way.
- **Platform splits live in the test, not in a blanket skip.** `tests/helpers/platform.ts` exposes
  `skipUnlessWindows`/`skipUnlessPosix`; a skipped test says why it is platform-specific.
  Never make a whole file conditional: the shared behaviour must still run on both.
- **Never register, enable, remove, or start a real systemd unit or scheduled task.** `task` is
  tested through `--dry-run` (units or `New-ScheduledTask` text) and through `task run`, which only
  checks and stages; a read-only `task status` query for a made-up name is allowed.
- **Fake the package manager** with `DSH_UPGRADE_PNPM_JS` (a Node script that stands in for
  `pnpm install` / `pnpm run build`). Real installs are never part of a test.
- **Free ports, always.** Bind port 0, close, use the number; never assume `3080`/`3099` are free
  (this machine serves the real GUI on 3080).
- **Clean up servers.** `t.after(() => stopPort(port))` for anything that starts one; a leaked
  listener fails later tests in the same run.
- **Shorten waits** with `DSH_UPGRADE_START_TIMEOUT_MS` instead of sleeping.
- **Do not register real scheduled tasks or create real desktop shortcuts.** Test the generated
  script text (`task install --dry-run --json`, `launcherFiles()`) instead.
- **Test the effect, not the call.** A detached `apply` is proven by polling the state file for
  the deployed tag; a rescue is proven by the copied file; a stop is proven by the port.
- Name tests for the behaviour ("stage re-prepares a slot when a patch was added") and assert the
  observable result. When a fixture writes a file, prefer the real format
  (`.dsh-build/client-build-environment.json`) over an invented one.

## Documentation

- One fact, one home: commands and JSON fields in `docs/commands.md`, invariants and failure
  behaviour in `docs/design.md`, symptoms and fixes in `docs/troubleshooting.md`, provenance and
  the archive layout in `docs/distribution.md`, the platform matrix in the README and decision
  0003, the plugin retirement in decision 0004.
- A doc statement that the code does not support is a defect; fix the code or the sentence in the
  same change.
- Decision records (`docs/decisions/`) are frozen once accepted: supersede, do not rewrite.
- `version.json` carries the tool version; a release tag must equal `v<version>`, which
  `release.yml` enforces. Do not bump the configuration or state `schema` without a migration
  story: an older file must still be readable or rejected loudly.

## Git

- One commit per milestone or one per coherent fix; the message says what was wrong and what now
  holds, not which files changed.
- Run `npm run typecheck` and `npm test` before committing. Do not push a red branch.
- Never force-push `main`; never commit a credential, an `OPENCODE_GO_API_KEY`, or a
  machine-specific `dsh-upgrade.json`.

## Do not

- Add a system service (see [docs/decisions/0001](docs/decisions/0001-no-windows-service.md) and
  [docs/decisions/0003](docs/decisions/0003-linux-parity.md)).
- Add a `dsh` shim or any `PATH` entry (see [docs/decisions/0002](docs/decisions/0002-no-dsh-shim.md)).
- Let the scheduled watcher or any background process switch versions: it prepares, a person
  applies.
- Write the operator's DSH profile at all: the tool no longer manages it (decision 0004).
- Truncate a log a failure message points at.
- Silence a failure with `catch {}`: an empty catch names the error and why it is safe.
