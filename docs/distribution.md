# Distribution

The product is a zip. Nothing is installed into `Program Files`, no service is registered, and
unpacking is the whole installation.

## What the zip contains

```
dsh-upgrade-<version>/
  .dsh-upgrade-release        version marker (proves this is an unpacked release)
  setup.cmd                   the one-shot installer
  src/                        the tool, run directly by Node 24 (no build step)
  engine-ps/tray.ps1          the tray companion
  plugins/opencode-session/   the vendored gateway plugin (MIT, with NOTICE)
  patches/manifest.json       the patch catalog
  package.json, version.json, README.md, LICENSE
```

No `node_modules`, no tests, no `dist/`. The tool has no runtime dependencies: Node 24 runs the
TypeScript sources through type stripping.

## Building a release

```powershell
node scripts/package.mjs               # writes dist\dsh-upgrade-<version>.zip
node scripts/package.mjs --dry-run     # prints the file list as JSON
node scripts/package.mjs --out D:\out  # somewhere else
```

The packager refuses to build an archive that would be unusable (a missing `src/cli.ts`,
`setup.cmd`, plugin, or catalog). `npm test` expands the produced zip and runs the unpacked tool,
so "the archive works" is checked, not assumed.

Tagging `v<version>` runs `.github/workflows/release.yml`: typecheck, tests, the zip, a
`SHA256SUMS.txt`, and a GitHub release with both files attached. The workflow runs on
`windows-latest` because the packager uses `Compress-Archive`.

## Installing on another machine

1. Check the prerequisites (`quick-start.md`): Node 24, PowerShell 7, git, pnpm.
2. Unpack the zip somewhere permanent.
3. `setup.cmd [root]`. It creates the layout, runs `doctor`, installs the plugin, and creates the
   desktop launchers. It stops at the first blocking problem and says which one.
4. `check`, `stage`, `apply` — or install the watcher with `task install`.

The tool never starts a background process during setup. The scheduled watcher is opt-in.

## Updating the tool itself

The tool is safe to replace: copy the new zip over the folder (keep `dsh-upgrade.json`, which is
written by `init` and lives beside the tool). Then:

```powershell
node src\cli.ts doctor
node src\cli.ts opencode-session install   # refreshes the vendored plugin in the profile
node src\cli.ts task status                # re-register if the wrapper path changed
```

`init` is idempotent and never overwrites an existing configuration unless `--force` is given.

## Version policy

- `version.json` holds `{name, version, schema, builtAt}`; `dsh-upgrade --version` reads it.
- The configuration has its own `schema` (currently `1`). A newer tool refuses a file it cannot
  interpret instead of guessing.
- The state file has a `schema` too; it is written atomically and a corrupt file fails loudly.

## Migrating from the legacy PowerShell tool (`E:\my\dsh-tools`)

The legacy scripts and this tool do the same job with the same layout; both point at
`<root>\deepseek-harness` and `<root>\dsh-slots`. Migrate by:

1. Unpacking the zip somewhere permanent.
2. Running `setup.cmd` with the same `root` as the legacy `dsh-upgrade.json`.
3. Running `task install` — it replaces the task the legacy installer registered
   (`DshUpstreamUpgrade`), so only one watcher remains.
4. Retiring the legacy folder once `check`, `stage`, and `apply` have done one real upgrade.

The legacy `rescued\`, `logs\`, and state file are not imported; the new tool starts with an empty
state and re-derives the deployed version from the junction.
