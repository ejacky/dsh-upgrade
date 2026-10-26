# 0001 — No Windows service

**Status:** accepted (2026-10)

## Context

The tool has two candidates for "keep doing something in the background": the periodic watcher
(does a newer release exist? prepare it) and the serving app itself. A Windows service is the
obvious mechanism for both, and the first version of this work considered one.

## Decision

No Windows service. Every process the tool starts belongs to the interactive user: the server,
the tray, and the scheduled watcher (an interactive-token task by default).

## Reasons

- **The harness is per-user by design.** It reads `%USERPROFILE%\.dsh` (profiles, settings,
  credentials, sessions). A service running as `LocalSystem` or another account would read a
  different home — a different instance, with none of the user's data.
- **Credentials.** The gateway needs `OPENCODE_GO_API_KEY` and the model providers need theirs.
  A service account needs its own copy of every secret, with its own rotation story and its own
  ACL surface. The interactive user already has them.
- **Session 0 is not a desktop.** The tray is a notification-area icon; the app opens a browser;
  the build may need an elevated console the user watches. None of that exists in session 0.
- **File ownership.** The slots, the junction, and the state file are the user's. A service would
  either take ownership (breaking the user's ability to fix things) or run with the user's
  profile anyway (defeating the point).
- **Self-upgrade.** The whole purpose is replacing the process that serves the app. A service
  manager that restarts on exit would fight the switch; a service that starts the *junction*
  target has to be stopped and started anyway.
- **Debuggability.** "Run this file in a console" is a complete installation procedure. A service
  adds a failure mode (`sc query`, event log, service account rights) for every user error.

## Consequences

- The watcher runs only while the account is logged on. `task install --s4u` is available for a
  machine that must check without a session, with the documented caveat that S4U sessions have no
  network credentials, which can break `git fetch`.
- Nobody can "start the service" as another user; the tool is installed per account.
- The server does not survive a log-off, which is correct for a per-user application.
- Uninstalling is deleting a folder and, optionally, `task remove` and `shortcuts --remove`.
