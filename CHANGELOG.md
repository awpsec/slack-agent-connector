# Changelog

## 0.2.0

- Add persistent sessions per profile, channel, or Slack thread, with visible conversation bindings.
- Preserve session identity on resume and reject shared IDs across isolated conversations.
- Keep queue order through retry backoff and failures; add delivery dismissal.
- Track thread participation per teammate and isolate context when switching Slack accounts.
- Preserve bindings and pending deliveries when saving unchanged settings or refreshing credentials.
- Make identical async callback retries idempotent and keep a fixed callback deadline.
- Distinguish transient webhook failures from invalid responses and permanent errors.
- Support native harness configuration arguments while reserving session/output flags.
- Add receiver version checks, idle upgrades, and graceful `stop`.
- Improve public setup links, bot/user manifests, settings refresh, connection errors, and narrow-screen layout.
- Extend offline coverage with migration, restart, scoped-context, and real process-bridge checks.

## 0.1.0

Initial standalone Events API receiver, private settings, MCP/native extension installation, and harness-neutral command/webhook adapters with Claude Code, Codex, pi, and omp conveniences.
