# 0004 — Retire the bundled OpenCode session plugin

**Status:** accepted

## Context

The tool used to ship `plugins/opencode-session`, a vendored copy of `dsh-x-opencode-session`, and
an `opencode-session install|remove|status` command that wrote it into the DSH profile. It existed
because the harness had no seam for a per-provider request header: `opencode-go` requests need
`x-opencode-session`, and the only ways to add it were a source patch or a fetch wrapper.

The harness now provides it itself. `@earendil-works/pi-ai` 1.3.0 wraps every `opencode-go` API
with `withOpenCodeSessionHeader`, which adds `x-opencode-session` from the harness session id
(`dist/providers/opencode-headers.js`); DSH's `llm-pi-ai` adapter passes `sessionId` through. No
profile layer, no patch, and no plugin is involved.

The tool only serves current and future harness checkouts, so the workaround is dead weight. Worse,
it is the only code in the tool that rewrites the operator's `cordis.patch.yml`, and it made
`doctor` report a healthy machine as missing the header.

## Decision

Remove the plugin and the command.

1. `plugins/opencode-session/` is deleted, along with `opencode-session` in the command table and
   the profile access code — `src/engine/profile.ts` read the profile, and the deleted
   `src/commands/opencodeSession.ts` wrote it.
2. The `opencodeSession` configuration block is removed from the schema. An older
   `dsh-upgrade.json` that still carries it loads unchanged: unknown keys are ignored, not
   rejected, so no migration is needed.
3. `doctor` replaces the profile probe with `provider-session-header`, which reads the installed
   pi-ai package and reports whether it adds `x-opencode-session`. A machine with no built harness
   yet is not warned; an older build is, with "stage and apply a newer release" as the fix.
4. `setup.sh` / `setup.cmd` drop the plugin step; the archive no longer carries `plugins/`.
5. A checkout older than pi-ai 1.3.0 cannot talk to the gateway until it is upgraded. That is the
   one behaviour the plugin used to cover, and it is accepted: the tool's job is to move forward.

## Consequences

- The tool no longer reads or writes the DSH profile at all. The configuration's `profile` and
  `opencodeSession` keys are ignored: an older file that carries them still loads, and nothing acts
  on them.
- The archive is smaller and the release has one fewer vendored dependency with a NOTICE.
- Someone who installed the plugin before this version keeps it in their profile. It is harmless
  (pi-ai skips a header that is already present), and `dsh plugin remove dsh-x-opencode-session`
  removes it. The tool no longer offers a removal command.
- This supersedes decision 0003's "Windows behaviour byte-for-byte" clause for the plugin
  surface only: that clause was written before the plugin removal, and the command, help line, and
  archive contents change as recorded here. The upgrade behaviour itself does not.
- `doctor` now needs the built checkout to answer; before the first `apply` it reports the probe as
  "no built harness yet" rather than failing.

## Alternatives rejected

- **Keep `install` for old checkouts.** It would keep the profile-writing code alive for a case the
  project explicitly does not serve, and it produced false alarms on current machines.
- **Detect at runtime and flip `install` into a no-op.** A command that usually does nothing still
  has to be documented, tested, and explained; deleting it is smaller than deprecating it.
- **Keep the plugin but stop installing it by default.** The code would still rewrite the profile
  when used, which is the risk this decision removes.
