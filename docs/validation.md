# Validation

Last checked: 2026-11-12. These results describe this checkout's checks, not a guarantee that every harness or Slack installation is configured correctly. Credentials, runtime databases, session IDs, and private Slack messages are excluded from the repository.

## Automated checks

All 64 tests and `npm run check` passed for v0.2.1. `npm test` runs offline. Slack API responses and native model output are fixtures. No automated test sends real Slack messages or starts a model.

Coverage includes signed HTTP ingestion and URL verification; mention/channel/DM rules; self/bot filtering; durable deduplication; an actual stdio MCP client; native extension schemas; installer configuration preservation; fixed and scoped session binding; distinct thread/channel contexts; account changes; no-op edits; migration from v0.1; ordered retries; callback races, expiry and duplicate results; cancellation; rate limits; uncertain sends; and interrupted-worker recovery.

Five new regression cases first reproduced failures in v0.2.0, then passed with the fixes: disconnecting an older account before replacing it, inheriting a fixed ID after a harness change, old thread participation after a session reset, older failures disappearing from activity, and forwarding a saved bearer credential to a changed webhook destination.

A command-bridge integration check launches actual child processes with disk-backed test memory, restarts the receiver/worker, and checks two isolated conversation contexts. The worker also calls a real local HTTP fixture service. This verifies process and persistence plumbing, not model reasoning or external connector authentication.

## Manual checks with real services

| Check | Result |
| --- | --- |
| Existing Slack connection posts and reads a dedicated private test thread | Passed |
| Fresh public GitHub checkout installs dependencies and begins generic MCP setup | Passed; one-time login, repeat installation, graceful stop, and restart also checked |
| 2026-11-12 fresh v0.2.1 install and idle upgrade from a real v0.2.0 receiver | Passed; upgrade replaced the receiver process while preserving its port, owner credentials, profile, and fixed context binding |
| Two new native Codex sessions retain different random markers on independent resume | Passed |
| Native Claude Code creates a persistent session and recalls a random marker on resume | Passed; session ID retained |
| 2026-11-12 Claude Code 2.1.323 recall check | Passed with an ordinary fictional-story fact and the same session ID. Two artificial random-marker probes returned an upstream model safety refusal on recall; those were recorded as failed probes |
| Signed HTTP requests wake real Codex sessions through the receiver and native adapter | Passed with synthetic Slack events and captured output; two thread markers recalled after receiver restart, with distinct session IDs preserved |
| Native Codex invokes an existing Context7 MCP tool | Passed |
| Resumed native Codex reads the private thread using the existing Slack app connector and retrieves a marker absent from its prompt | Passed |
| Resumed native Codex posts one reply through that Slack connector containing both the thread marker and its original session marker | Passed; confirmed by reading the actual Slack thread |
| 2026-11-12 live Slack retest with Codex CLI 0.166.0 | Passed; two new private threads, independent session IDs, correct read/recall results, and one actual reply from each session. Both replies confirmed by reading Slack |
| Actual pi 0.73.1 and omp 18.20.0 CLIs, including Bun 1.4.4 for omp | Passed with a local streamed provider fixture: real package installation, extension discovery, a native `slack_status` tool call, creation/resume, distinct sessions, and preserved original transcript after another session runs |
| Settings at desktop and narrow mobile widths | Passed; no overflow or console errors in the tested flow |
| Settings preserves scoped bindings on instruction edits and reflects account/profile changes | Passed with a fixture identity |
| Public HTTPS tunnel reaches the real receiver health endpoint | Passed |
| Slack Events API automatically wakes a model session and receives its reply | Pending dedicated Slack test-app authorization |
| Live external model execution/authentication in pi and omp | Not verified; the installed CLIs used a local provider fixture for protocol, tool, and transcript checks |
| Arbitrary cloud or active-session harness bridge | Contract and offline bridges verified; a real bridge must be checked in its own environment |

The Slack app connection already present in a harness gives that session Slack tools. It does not expose a new app's signing secret or register event subscriptions for this receiver. The successful manual Slack checks therefore do not prove automatic event wake-up. That final check requires an installed Slack app, matching credentials, an enabled event subscription, and a public receiver URL.

The native CLI checks used temporary, isolated configuration directories and a fixture receiver. They installed the generated packages through the connector's real installer and loaded them through each host's package settings, rather than substituting a mock extension API. The local provider requested the real status tool and inspected the actual tool result and resumed transcript. This checks host integration without claiming that the fixture is a real model or Slack event source.

Native harness permissions, provider policies, and model refusals remain in effect. The Claude marker refusals above were model responses, not a changed session ID or a command failure. The connector passes those responses through; successful session resumption does not guarantee that a model will answer every message.

## Repeat the live event check

Use a dedicated test identity/channel and explicitly authorize real model runs and Slack test messages.

1. Connect the test Slack app and configure its Events API request URL. Check Slack's URL verification succeeds.
2. Create an enabled native profile with `session_scope: "thread"` and a channel-only `mentions_and_replies` rule. Invite the bot to that channel.
3. From a different Slack identity, mention the bot in two separate root messages, giving each a distinct random marker. Confirm two completed deliveries and two distinct saved session IDs.
4. Reply in each thread without a mention and ask for its marker without repeating it. Confirm the replies recall the correct marker and retain the corresponding session ID.
5. Restart the receiver; repeat the recalls. Check an unmentioned root is ignored, an explicit channel `off` rule wins, pause suppresses new work, and bot replies do not trigger loops.
6. Ask the session to use an existing harmless connector tool and confirm its actual result. Inspect the harness trace if available.

Report the actual Slack replies and delivery/session records separately from fixture tests. A connected account or healthy tunnel alone does not complete this check.
