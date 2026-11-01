# Distribution

The product is an archive. Nothing is installed into `Program Files` or `/usr`, no service is
registered, and unpacking is the whole installation.

## What the archive contains

Windows — `dsh-upgrade-<version>.zip`:

```
dsh-upgrade-<version>.zip
  .dsh-upgrade-release        version marker (proves this is an unpacked release)
  setup.cmd                   the one-shot installer
  src/                        the tool, run directly by Node 24 (no build step)
  engine-ps/tray.ps1          the tray companion
  patches/manifest.json       the patch catalog
  docs/                       the documents in this folder
  package.json, version.json, README.md, LICENSE
```

Linux — `dsh-upgrade-<version>.tar.gz`:

```
dsh-upgrade-<version>.tar.gz
  .dsh-upgrade-release        version marker
  setup.sh                    the one-shot installer (POSIX sh, ASCII)
  src/                        the tool, including src/engine/host.ts
  patches/manifest.json
  docs/
  package.json, version.json, README.md, LICENSE
```

There is no `engine-ps/` and no `setup.cmd` in the Linux archive: the tray is Windows-only, and
a script that cannot run is not shipped. `tray` exits `3` with a pointer to the launchers.

The archive stores its contents at the root: unpack it into the folder the tool should live in,
not into a subfolder, or the installer will treat that subfolder as the tool.

`scripts/` (including the packager) is not shipped: it is a maintainer tool that runs from a
source checkout.

No `node_modules`, no tests, no `dist/`. The tool has no runtime dependencies: Node 24 runs the
TypeScript sources through type stripping.

## Building a release

```sh
node scripts/package.mjs               # dist/dsh-upgrade-<version>.zip or .tar.gz, by host OS
node scripts/package.mjs --dry-run     # prints the file list as JSON
node scripts/package.mjs --out /tmp/out  # somewhere else
```

The packager refuses to build an archive that would be unusable (a missing `src/cli.ts`,
installer, or catalog). `npm test` expands the produced archive and runs the unpacked
tool, so "the archive works" is checked, not assumed.

The JSON summary always names `archive` and `platform`; on Windows it also keeps `zip`, which
older scripts read.

Tagging `v<version>` runs `.github/workflows/release.yml`: two jobs, each with typecheck, tests,
the archive for its platform, a checksum file, and a GitHub release. The Windows job attaches
`dsh-upgrade-<version>.zip` and `SHA256SUMS.txt`; the Linux job attaches
`dsh-upgrade-<version>.tar.gz` and `SHA256SUMS-linux.txt`.

## Installing on another machine

**Windows**

1. Check the prerequisites (`quick-start.md`): Node 24, PowerShell 7, git, pnpm.
2. Unpack the zip somewhere permanent.
3. `setup.cmd [root]` creates the layout, runs `doctor`, and creates the
   desktop launchers. It stops at the first blocking problem and says which one.
4. `check`, `stage`, `apply` — or install the watcher with `task install`.

**Linux**

1. Check the prerequisites: Node 24, git, pnpm; systemd for `task install`.
2. `tar -xzf dsh-upgrade-<version>.tar.gz -C /opt/dsh-tools` (the folder must exist).
3. `sh /opt/dsh-tools/setup.sh [root]` — same sequence as `setup.cmd`, with `.desktop` entries
   instead of shortcuts.
4. `check`, `stage`, `apply` — or `task install` for the systemd user timer.

The tool never starts a background process during setup. The watcher is opt-in.

## Updating the tool itself

The tool is safe to replace: unpack the new archive over the folder (keep `dsh-upgrade.json`,
which is written by `init` and lives beside the tool). Then:

```sh
node src/cli.ts doctor
node src/cli.ts task status                # re-register if the wrapper or unit path changed
```

`init` is idempotent and never overwrites an existing configuration unless `--force` is given.

## Version policy

- `version.json` holds `{name, version, schema, builtAt}`; `dsh-upgrade --version` reads it.
- The configuration has its own `schema` (currently `1`). A newer tool refuses a file it cannot
  interpret instead of guessing.
- The state file has a `schema` too; it is written atomically and a corrupt file fails loudly.
- Configurations are platform-local: a Windows `dsh-upgrade.json` records Windows paths and is not
  meant to be copied to a Linux machine (and the reverse).

## Migrating from the legacy PowerShell tool (`E:\my\dsh-tools`)

The legacy scripts and this tool do the same job with the same layout; both point at
`<root>\deepseek-harness` and `<root>\dsh-slots`. Migrate by:

1. Unpacking the zip somewhere permanent.
2. Running `setup.cmd` with the same `root` as the legacy `dsh-upgrade.json`.
3. Running `task install` — it replaces the task the legacy installer registered
   (`DshUpstreamUpgrade`), so only one watcher remains.
4. Retiring the legacy folder once `check`, `stage`, and `apply` have done one real upgrade.

The legacy `rescued\`, `logs\`, and state file are not imported; the new tool starts with an empty
state and re-derives the deployed version from the link.
