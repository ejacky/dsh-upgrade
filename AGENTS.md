# AGENTS.md

`dsh-upgrade` upgrades a **DeepSeek Harness source checkout** on Windows with two slot checkouts
(`<root>\dsh-slots\a|b`) behind one stable-path junction. It also ships a tray companion, a
scheduled watcher, and a vendored gateway-header plugin.

Read [docs/design.md](docs/design.md) before changing anything under `src/engine/`; it explains
the invariants below and why they exist. [docs/commands.md](docs/commands.md) owns the command,
flag, exit-code, and JSON contract; [docs/troubleshooting.md](docs/troubleshooting.md) owns the
failure symptoms.

## Commands

```powershell
node src/cli.ts --help        # run from sources; Node 24 strips the types, there is no build step
node src/cli.ts doctor        # probe this machine before blaming a code change
npm run typecheck             # tsc --noEmit (strict; see tsconfig.json)
npm test                      # node --test, all offline (~30 s)
node --test tests/apply.test.ts   # one file while iterating
node scripts/package.mjs --dry-run   # what the release zip would contain
node scripts/package.mjs             # write dist/dsh-upgrade-<version>.zip
```

CI (`.github/workflows/ci.yml`) runs `npm install`, `npm run typecheck`, and `npm test` on
`windows-latest`. Those two checks are the gate for landing a change, so run them locally first.

## Layout

```
src/cli.ts            command table, global flags, exit codes, help
src/commands/*.ts     one file per command; it parses its own flags and prints its own output
src/engine/*.ts       the layout, state, locks, git, pnpm, service, smoke test, patches, profile
src/version.ts        reads version.json
engine-ps/tray.ps1    the tray companion (PowerShell 7 + WinForms)
plugins/opencode-session/  the vendored gateway plugin (plain JS, MIT, see NOTICE.md)
patches/manifest.json the patch catalog (empty by default)
scripts/package.mjs   builds the green zip
setup.cmd             ASCII-only one-shot installer for an unpacked release
docs/                 quick-start, commands, design, troubleshooting, patch-tracks,
                      distribution, opencode-session, decisions/
tests/*.test.ts       one file per surface: most spawn the real CLI; primitives are unit-tested
```

## Invariants

A change must keep all of these. Each one is enforced by a guard or a test; if a guard has to
move, move its test with it.

1. **Never write the serving slot.** `stage` writes only `spareSlot()`; it refuses a slot outside
   `slotsRoot`, the active slot, a real directory at `stablePath`, and a machine where `webPort`
   is served but the junction does not identify a slot.
2. **Never leave the machine serving nothing.** A failed switch restores the previous junction
   *and* restarts the previous server. `apply --no-start` flips the junction and leaves the
   running server alone.
3. **Never report an effect you did not observe.** `stop` waits for the port, `apply` waits for a
   URL that the process it started answers, `stage` smoke-tests the built entry, `install`
   re-reads the profile, `task install` re-queries the task.
4. **One writer at a time.** `stage`, `apply --wait`, the detached `apply` worker, and `rollback`
   take `state/layout.lock`. `acquireLock` publishes atomically; a live owner is never evicted.
5. **Versions only move forward.** `check` proposes strictly newer tags; `stage --tag` refuses a
   non-newer tag unless `--force`; `apply` refuses a slot that is no longer at the staged tag.
6. **Deletes never follow a junction.** `removeTree` resolves the root, unlinks links, and refuses
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
- **JSON output is a compatibility promise.** The tray and the scheduled task parse it; adding a
  field is fine, renaming one is a breaking change that needs a docs update and a test.

### Adding or changing a command

1. Put the implementation in `src/commands/<name>.ts`, exporting one `run<Name>` that returns the
   exit code (async only when it must await a server).
2. Add it to the `COMMANDS` table in `src/cli.ts` with a summary, a usage hint, and
   `implemented: true`.
3. Support `--json` on every path, including failures (`{ok: false, error, nextAction}`).
4. Add a test file that spawns `src/cli.ts` and asserts exit codes and JSON, not internals.
5. Update `docs/commands.md` (the flag and JSON contract) and, if behaviour changed,
   `docs/troubleshooting.md`.

## Windows specifics

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

## Testing

- **Offline and self-contained.** Every test builds its own fixture under `%TEMP%` and deletes
  nothing outside it. No test may touch the real `~/.dsh`: pass `DSH_HOME` at a temp directory.
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
  observable result. When a fixture writes a file, prefer the real format (`cordis.patch.yml`,
  `.dsh-build/client-build-environment.json`) over an invented one.

## The vendored plugin

`plugins/opencode-session` is a modified copy of `dsh-x-opencode-session` 0.1.0 (MIT). Keep the
upstream `LICENSE` unchanged; every local change belongs in `NOTICE.md` and in the module header.
To update it: fetch the upstream package, diff `lib/index.js` against the copy, re-apply the
config validation and the parameterised `wrapFetch`, bump the package version, and update
`NOTICE.md` with the new upstream version. Its behaviour is tested in `tests/plugin.test.ts`
(header decision, `Request` headers, config validation), which is the part the installer tests
cannot see.

## Documentation

- One fact, one home: commands and JSON fields in `docs/commands.md`, invariants and failure
  behaviour in `docs/design.md`, symptoms and fixes in `docs/troubleshooting.md`, provenance and
  the zip layout in `docs/distribution.md`, the plugin in `docs/opencode-session.md`.
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

- Add a Windows service (see [docs/decisions/0001](docs/decisions/0001-no-windows-service.md)).
- Add a `dsh` shim or any `PATH` entry (see [docs/decisions/0002](docs/decisions/0002-no-dsh-shim.md)).
- Let the scheduled watcher or any background process switch versions: it prepares, a person
  applies.
- Replace the operator's `cordis.patch.yml` without a `.bak-<stamp>` copy, or with a non-atomic
  write.
- Truncate a log a failure message points at.
- Silence a failure with `catch {}`: an empty catch names the error and why it is safe.
