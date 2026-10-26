# The gateway session header (`opencode-session`)

Requests sent to an OpenCode gateway (`opencode.ai`) must carry an `x-opencode-session` header
whose value identifies the conversation. DeepSeek Harness has no configuration key for a
per-provider request header, and upstream has not accepted one, so this machine used to patch
`llm-pi-ai` at the source.

That era is over: the same header now comes from a plugin, installed by the tool, and it survives
every upgrade because the profile — not the checkout — owns it.

## What the plugin does

Two host-side layers in one small package:

1. an `llm/stream` waterfall listener wraps each model request in an `AsyncLocalStorage`
   context carrying `options.sessionId`;
2. a one-time `globalThis.fetch` patch adds the header when the URL matches a configured marker
   and that context holds a session id.

The value is the session id the agent loop already puts in every request, so it is stable within
a conversation, different between conversations, and unchanged by a restart or a network drop.
The plugin keeps no ids and no map. Side-channel requests (usage queries, model discovery, web
tools) are untouched because they run outside the session context.

## Installing it

```powershell
node src\cli.ts opencode-session install
```

The command:

1. packs the vendored plugin (`plugins\opencode-session`) into `state\plugins\` and installs it
   into the profile with `dsh plugin --profile <profile> add <tgz>`, which records it as a profile
   layer — that is what loads its `cordis.patch.yml` row;
2. re-reads the profile and reports the version, instead of trusting the exit code;
3. removes a provider `sessionHeader` from the profile patch if one is left (the patch is backed
   up as `cordis.patch.yml.bak-<timestamp>` first), because two mechanisms sending one header is
   a bug waiting to happen;
4. writes an id-targeted settings override **only** when `dsh-upgrade.json` asks for a header or
   URL marker other than the plugin default.

Then restart the web service (or use the tray's "打开 DSH" after an `apply`) for the change to
take effect.

## Settings

Defaults are `x-opencode-session` on URLs containing `opencode.ai`. To use something else:

```json
{
  "opencodeSession": {
    "enabled": true,
    "source": "builtin",
    "npmVersion": "^0.1.0",
    "header": "x-my-session",
    "urlMarkers": ["gateway.example"]
  }
}
```

`source` selects where the package comes from: `builtin` (the vendored copy, works offline),
`npm` (the published `dsh-x-opencode-session` at `npmVersion`, default `^0.1.0`), `off` (install
refuses). `enabled: false` means the tool leaves the profile alone; `doctor` then reports the
header as intentionally absent. If `npm pack` cannot run at all, `install` links the vendored
directory instead and says so — that works, but moving the tool later breaks the profile.

`install` turns that into an override block in the profile patch:

```yaml
# dsh-upgrade: x-opencode-session settings (written by "dsh-upgrade opencode-session install")
- id: x-opencode-session
  config:
    header: x-my-session
    urlMarkers:
      - gateway.example
```

The row's config is validated by the plugin: a bad header or an empty marker list throws at load
instead of silently dropping the header. Re-running `install` with default settings removes an
override it wrote earlier, so the profile never carries two contradicting settings.

`source` selects where the package comes from: `builtin` (the vendored copy, works offline),
`npm` (`dsh-x-opencode-session` at `npmVersion`), `off` (install refuses).
`enabled: false` means the tool leaves the profile alone; `doctor` then reports the header as
intentionally absent.

## Checking it

```powershell
node src\cli.ts opencode-session status
node src\cli.ts doctor            # the "opencode-session" probe
```

`status` reports the installed version, whether the profile lists it as a layer, whether the
settings override is present, and whether a legacy provider `sessionHeader` still exists. The
`doctor` probe answers the same question for an operator who does not want to read JSON: plugin,
legacy setting, or nothing — and what to do. It treats a package that is installed but missing
from `dsh.profile.bundles` as a failure, because that row is never loaded: the header would be
silently absent.

## Removing it

```powershell
node src\cli.ts opencode-session remove
```

This runs `dsh plugin remove`, deletes the settings override, and prints the restart reminder. A
provider `sessionHeader` is **not** restored; if the gateway needs the header and you are going
back to a patched source build, put the setting back in the profile patch by hand.

## Provenance

The plugin is a vendored copy of `dsh-x-opencode-session` 0.1.0 by Coco-king (MIT). The upstream
licence and a `NOTICE.md` describing the local changes travel with it, and
`plugins/opencode-session/lib/index.js` says the same thing in its header. To update it, re-fetch
the upstream package, diff, re-apply the local changes, and bump the notice.
