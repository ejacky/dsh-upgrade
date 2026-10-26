# Patch tracks

A source patch is the escape hatch for behaviour that has neither a configuration key nor a
plugin seam. The tool keeps patches deliberately boring: a list of files, applied to every
staged slot, refused loudly when one no longer applies.

## The two lists

| Where | What it is |
|---|---|
| `patches\manifest.json` | the **catalog**: every patch the tool ships or knows about, with its purpose, issue, and verified tags |
| `dsh-upgrade.json` → `patchFiles` | the **active set**: what staging applies, in that order |

`dsh-upgrade patch add <name>` copies a catalog entry into the active set; `patch add --file
<path>` registers a patch outside the catalog. Both edit only `patchFiles` in the raw JSON, so
other keys and the spelling of every path survive.

## Catalog schema

```json
{
  "schema": 1,
  "patches": [
    {
      "name": "llm-pi-ai-session-header",
      "file": "patches/llm-pi-ai-session-header.patch",
      "summary": "send the DSH session id to the gateway as x-opencode-session",
      "upstreamIssue": "https://github.com/deepseek-ai/deepseek-harness/issues/0000",
      "verifiedTags": ["dsh-v0.2.1-rc.3"],
      "obsoleteSince": "dsh-v0.2.2-rc.1"
    }
  ]
}
```

- `file` is relative to the tool root (an absolute path is stored exactly as written).
- `verifiedTags` is the honest record of the last tags the patch was proven against; update it
  when you verify a new release.
- `obsoleteSince` marks the release that made the patch unnecessary. An obsolete patch is still
  applied if it is configured (unless the tree already contains it), but `patch list` tells you
  to remove it.
- Unknown fields and duplicate names or files are rejected. The catalog ships with the tool, so a
  typo is a mistake, not forward compatibility.

## Writing a patch

From a slot checkout at the tag you care about:

```powershell
cd E:\my\dsh-slots\a
git diff -- path\to\file.ts > E:\my\dsh-tools\patches\my-fix.patch
```

Rules that keep a patch track alive:

1. **Small and single-purpose.** One behaviour per file; several files means several patches.
2. **No build output, no generated files.** A patch that touches `lib/` will rot in a week.
3. **Context lines, not line numbers.** `git diff` gives you context; a hand-written patch
   without `index` lines still applies, but three-way merges are unavailable.
4. **Record the reason.** The `summary` and `upstreamIssue` are what a future maintainer needs to
   decide whether the patch is still wanted.

## Checking a patch

```powershell
dsh-upgrade patch verify            # against the serving slot
dsh-upgrade patch verify --all      # include catalogued patches that are not applied
dsh-upgrade patch verify --slot b   # a specific checkout
```

Each patch is checked in both directions:

| State | Meaning | What to do |
|---|---|---|
| `applies` | the patch applies cleanly | nothing |
| `applied` | reverse-applying succeeds: the tree already carries it | usually a sign upstream took the fix; consider `obsoleteSince` |
| `conflict` | neither direction applies | rebase the patch onto the new tag, or remove it |
| `missing` | the file named by the catalog or `patchFiles` is not there | fix the path or reinstall |

`verify` exits `3` only when a **configured** patch needs a human; a catalogued patch that is not
applied is reported without failing.

## When a stage fails on a patch

`stage` exits `3` and names the patch, the tag, and the fix:

```
patches/my-fix.patch does not apply to dsh-v0.2.2-rc.1: error: patch failed: src/a.ts:12.
Rebase it onto dsh-v0.2.2-rc.1, or remove it with "dsh-upgrade patch remove my-fix".
```

The slot is left as it was checked out (patched with whatever applied before the failure); the
staged record is **not** written, so `apply` has nothing to switch to.

## Retiring a patch

1. Check whether the release still needs it: `patch verify` reporting `applied` on the new
   checkout is the practical answer.
2. Set `obsoleteSince` in the catalog and `patch remove <name>`.
3. When the last supported version contains the fix, delete the patch file and the catalog entry.

## Policy

- Prefer a configuration value, then a plugin, then a patch.
- Never ship a patch that only exists because a build artefact was hand-edited.
- A patch list that grows is a signal to file the upstream issue, not to add a sixth patch.
- The shipped catalog is empty on purpose: the one behaviour this machine used to patch (the
  gateway session header) is now a plugin — see [opencode-session.md](opencode-session.md).
