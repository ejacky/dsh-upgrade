# NOTICE

`plugins/opencode-session` contains a modified copy of **dsh-x-opencode-session 0.1.0**,
published by Coco-king (https://github.com/Coco-king/dsh-x-opencode-session, npm package
`dsh-x-opencode-session@0.1.0`), licensed MIT. The upstream `LICENSE` file is included
unchanged.

## Why it is vendored

`dsh-upgrade` ships as a green zip that must install without network access, and the plugin
has to keep working across DSH upgrades, so the copy lives beside the tool instead of in the
profile's `node_modules`.

## Local changes against 0.1.0

- `apply(ctx, config)` validates the row's config (`header`, `urlMarkers`) and throws on a
  value it cannot honour; the upstream copy used fixed constants. Defaults are unchanged.
- `wrapFetch(realFetch, options)` takes the header and markers as arguments instead of
  reading module constants, so the decision is testable.
- Comments and JSDoc are in English and describe the header/URL-marker contract.
- Package version is `0.1.1` to distinguish the vendored build from the published `0.1.0`.

Nothing else was changed: the fetch patch, the `llm/stream` listener, the session-context
handling, and the disposal behaviour are the upstream implementation.

## Updating

Re-fetch the upstream package, diff `lib/index.js` against this copy, re-apply the changes
above, and update this notice with the new upstream version.
