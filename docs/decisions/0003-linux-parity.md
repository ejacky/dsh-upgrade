# 0003 — Linux parity without changing Windows

**Status:** accepted

## Context

The tool was written for one machine shape: a Windows box where a directory junction names the
serving slot, Task Scheduler runs the watcher, and a PowerShell 7 tray is the one-click control.
Four behaviours were therefore hard-coded to Windows: finding the process that owns the web port
(`netstat`), ending a process tree (`taskkill`), replacing the stable path (a junction), and the
launcher/watcher/tray trio (PowerShell, `wscript`, `Register-ScheduledTask`).

DeepSeek Harness itself runs on Linux, so the same upgrade problem exists there. The question was
whether to port the tool, and on what terms.

## Decision

Add Linux as a supported platform, and keep the Windows *upgrade* behaviour byte-for-byte where
it is observable. Retiring the bundled plugin is a separate, recorded change (decision 0004).

1. **One platform seam.** `src/engine/host.ts` owns the low-level primitives (port owner,
   process tree, link swap, launcher/unit directories, child process group, pnpm executable).
   Commands ask for the behaviour, never for `process.platform`, with four recorded exceptions
   where the *output* differs rather than a capability: the `task` renderers (Task Scheduler
   script vs systemd units), the `shortcuts` renderers (`.lnk` vs `.desktop`), the `tray`
   capability guard, and the `doctor` probe list. The Windows implementations are moved, not
   rewritten.
2. **Portability is observable, not assumed.** Windows keeps its original answer: a port is
   free when `netstat` names no listener, so the proof does not change under existing installs.
   Linux asks `/proc/net/tcp{,6}` — which sees every namespace listener, including another
   account's and an IPv6-only one — and falls back to a bind probe that only treats
   `EADDRINUSE` as proof of a listener. When no source can name the owner, the tool says so and
   refuses to claim the port was freed.
3. **The link swap is atomic where the platform allows it.** Windows keeps unlink + junction.
   Linux creates a temporary symlink and renames it over the old one, so the stable path never
   names nothing.
4. **No tray outside Windows.** There is no dependency-free tray toolkit, and adding one would
   break the "no runtime dependencies" rule for a convenience. `tray` exits `3` and points at the
   `.desktop` launchers and `toggle`.
5. **The watcher stays a user process.** Windows keeps Task Scheduler; Linux uses a systemd user
   timer (`systemctl --user`). Neither is a system service — decision 0001 still holds — and
   neither switches versions.
6. **The release is per-platform.** Windows keeps `dsh-upgrade-<version>.zip` and `setup.cmd`;
   Linux gets `dsh-upgrade-<version>.tar.gz`, `setup.sh`, and no `engine-ps/`. The packager uses
   only tools the host already has (`Compress-Archive` or `tar`).
7. **Both platforms are gates.** CI runs typecheck and tests on `windows-latest` and
   `ubuntu-latest`. A platform-specific assertion is skipped only in a file that names the other
   platform's implementation.

## Consequences

- A change that touches `host.ts` needs a test on both platforms; the seam is the only place a
  platform bug can live.
- The suite has platform-split cases: Task Scheduler/`.vbs`/`.lnk` assertions on Windows, systemd
  units and `.desktop` entries elsewhere. `tests/helpers/platform.ts` is the one place that
  decides which is which.
- The JSON surface gains `platform` and `archive` in the packager summary and `unit`/`subState`
  on Linux `task status`. `zip` stays on Windows for older scripts; nothing was renamed.
- Documentation states a platform matrix; a capability that is absent is an exit code, not a
  sentence in a log.

## Alternatives rejected

- **WSL as the Linux story.** It is still a Windows machine, with a Windows junction and a Windows
  server; it does not test the code paths a real Linux host uses.
- **A systemd *system* service for the watcher.** It would cross the line decision 0001 draws, and
  a watcher that prepares versions does not need root.
- **A GTK/AppIndicator tray.** A new runtime dependency, a second GUI toolkit, and a packaging
  problem, for a control that `toggle` and a `.desktop` entry already provide.
- **Shelling out to `lsof`/`ss` as the only port probe.** They are not guaranteed to be installed;
  `/proc` is, and the bind probe needs nothing at all.
