# Design

The tool exists because "follow upstream release tags" and "keep the instance I am using"
are in conflict on a machine where the harness runs from source. Everything here follows from
one rule: **the serving tree is read-only while a new version is prepared, and nothing switches
without an explicit `apply`.**

## Slots and the stable path

```
<root>/deepseek-harness      link      ->  <root>/dsh-slots/a   (serving)
<root>/dsh-slots/a           checkout at dsh-v0.2.1-rc.3, built, serving
<root>/dsh-slots/b           checkout at dsh-v0.2.1-rc.2, idle
```

The server is started from a slot directory, and the stable path names the slot that is
serving; that is what `status` and a person's shell use. Switching is one
link replacement plus a restart. On Windows the link is a directory junction, created by
unlinking the old entry and making the new one; on Linux it is a symlink and the swap is atomic
(a temporary symlink renamed over the old one), so the stable path never names nothing. Either
way a running process keeps the directory it opened, so the old server is stopped and the new
slot started rather than expecting the flip to move it.

The platform-dependent primitives live in `src/engine/host.ts`: port ownership, ending a
process tree, replacing the link, where a launcher and a systemd unit belong, and the two spawn
details (process group, package-manager executable). Commands ask for the behaviour, never for
`process.platform`, so a platform that cannot provide one fails loudly instead of pretending it
worked. Four renderers stay outside the seam because their *output*, not a capability, differs:
`task` writes a Task Scheduler script or systemd units, `shortcuts` writes `.lnk` wrappers or
`.desktop` entries, `tray` refuses on a platform without the toolkit, and `doctor` chooses its
probe list (and the platform's install hint).

The slot the tool may write is `spareSlot`: the one that is **not** the current link target.
Before the first switch that is slot `a`. `stage` asserts the resolved slot path is inside
`slotsRoot` and is not the serving slot before writing anything.

## One writer at a time

`state/layout.lock` is an exclusive file with the owner's pid. `stage`, `apply --wait`, the
detached `apply` worker, and `rollback` all take it. The lock is published atomically (a private
temporary file hard-linked into place, so a contender cannot read a half-written lock), and
releasing checks the file still names this process. A leftover lock is reclaimed immediately when
its pid is gone, or after 24 hours if the pid was reused by an unrelated process; a live owner is
never evicted. A contended run exits `3` at once, which the tray surfaces as the CLI's own
"another layout action is running".

## Upgrades are prepared, then switched

1. `stage` clones or reuses the spare slot (a worktree of the other slot when one exists),
   rescues uncommitted changes to `rescued/`, applies configured patches, installs, builds, and
   smoke-tests the built entry on `smokePort` with an isolated `DSH_HOME`.
2. `apply` validates the staged record and that the slot is still at that tag, flips the
   stable-path link, stops the server on `webPort`, starts the new one, and waits for the URL that
   server printed. A bare `/` answer only counts when the listener is the process `apply`
   started, so an old build still holding the port cannot make a failed switch look successful.
3. If anything fails, the link goes back to the previous slot **and the previous server is
   restarted**, because a failed switch must not leave the machine with nothing serving.

`apply` runs as a detached worker. The tool may be running inside the very server it replaces,
so it must never do the work in its own process; `--wait` exists for tests and for an operator
who wants the output.

## Plans that need a human

`manualBuild` exists because some Windows protection drivers refuse a child process the right to
delete a large temporary file, which makes the esbuild-driven web build fail with `Access is
denied` no matter which process starts it. `doctor` probes this on Windows only; on Linux the
flag is accepted but nothing sets it. On such a machine:

1. `stage` installs, writes `state/build-request.json`, and exits `3`;
2. a human runs `pnpm run build` in that slot from an administrator console;
3. `stage --resume` verifies the tag, requires the build record, smoke-tests, and records the
   slot.

The tray automates 2 and 3 by opening an elevated console that runs `pnpm run build` and then
`stage --resume`.

## Patches are a fallback, not a habit

The tool prefers a configuration or plugin seam and treats source patches as an escape hatch with
a cost: every patch is a rebase waiting to happen. `patchFiles` applies to every staged slot;
`patch verify` proves a patch still applies before a stage discovers it the hard way; `stage`
refuses to prepare a version with a half-applied patch set. The catalog in
`patches/manifest.json` records what each patch is for and the release that made it unnecessary.
See [patch-tracks.md](patch-tracks.md).

The OpenCode gateway's session header ended both the patch era and the plugin era: pi-ai
1.3.0 sends `x-opencode-session` from the harness session id, so the tool no longer touches the
DSH profile at all. See
[decisions/0004-retire-opencode-session-plugin.md](decisions/0004-retire-opencode-session-plugin.md).

## What the tool refuses to do

- Switch versions on its own. The scheduled watcher prepares; a person (or the tray) applies.
- Write the serving slot. Every write target is asserted to be the spare slot.
- Delete through a link. `removeTree` refuses paths outside the allowed roots and unlinks
  junctions/symlinks instead of following them.
- Report success it cannot see. `stop` waits for the port, `apply` waits for the URL,
  `task install` re-queries the task, and `doctor` probes rather than assuming.
- Run as a system service. The watcher is an interactive-user process: a Windows scheduled task
  or a systemd **user** timer. See
  [decisions/0001-no-windows-service.md](decisions/0001-no-windows-service.md) and
  [decisions/0003-linux-parity.md](decisions/0003-linux-parity.md).

## Failure behaviour

| Situation | Behaviour |
|---|---|
| `git fetch` fails | `check` exits `4` and records `lastError`; a stale local tag list is still shown |
| install hangs on a prompt | stdin is not a terminal, `CI=1` is set, and a timeout kills the tree |
| stale `node_modules` layout | `node_modules` is removed and the install retried once |
| build fails | `stage` exits `4`, records the tail, stages nothing |
| smoke fails | `stage` exits `4`; the serving slot was never touched |
| switch fails | link restored, previous server restarted, `deployed` unchanged |
| patch conflicts | `stage` exits `3`, names the patch and the tag, and stages nothing |
