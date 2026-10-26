# dsh-x-opencode-session (vendored)

A DeepSeek Harness plugin that adds the `x-opencode-session` header to model requests sent to
an OpenCode gateway (`opencode.ai`), carrying the conversation's own session id.

`dsh-upgrade` installs it with `dsh-upgrade opencode-session install`; do not edit this
directory by hand. This copy is vendored from the upstream package so a green-zip install
works offline; see `NOTICE.md` for provenance and the local changes.

## Behaviour

- The header value is the session id the agent loop already puts in every model request, so it
  is stable within a conversation, different between conversations, and unchanged by a
  restart or a network drop.
- Only requests whose URL contains a configured marker receive the header. Usage queries,
  model discovery, and web tools are untouched.
- Settings, when needed, come from the row's config in the profile patch:

  ```yaml
  - id: x-opencode-session
    config:
      header: x-opencode-session
      urlMarkers: [opencode.ai]
  ```

  `dsh-upgrade opencode-session install` writes that override only when `dsh-upgrade.json`
  asks for values other than the defaults.

## License

MIT — see `LICENSE` (upstream) and `NOTICE.md` (provenance and local changes).
