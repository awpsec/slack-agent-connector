# Validation

Last checked: 2026-11-05. These results describe this checkout's checks, not a guarantee that every harness or Slack installation is configured correctly. Credentials, runtime databases, session IDs, and private Slack messages are excluded from the repository.

## Automated checks

All 59 tests and `npm run check` passed for v0.2.0. `npm test` runs offline. Slack API responses and native model output are fixtures. No automated test sends real Slack messages or starts a model.

Coverage includes signed HTTP ingestion and URL verification; mention/channel/DM rules; self/bot filtering; durable deduplication; an actual stdio MCP client; native extension schemas; installer configuration preservation; fixed and scoped session binding; distinct thread/channel contexts; account changes; no-op edits; migration from v0.1; ordered retries; callback races, expiry and duplicate results; cancellation; rate limits; uncertain sends; and interrupted-worker recovery.

A command-bridge integration check launches actual child processes with disk-backed test memory, restarts the receiver/worker, and checks two isolated conversation contexts. The worker also calls a real local HTTP fixture service. This verifies process and persistence plumbing, not model reasoning or external connector authentication.

## Manual checks with real services

| Check | Result |
| --- | --- |
| Existing Slack connection posts and reads a dedicated private test thread | Passed |
| Fresh public GitHub checkout installs dependencies and begins generic MCP setup | Passed; one-time login, repeat installation, graceful stop, and restart also checked |
| Two new native Codex sessions retain different random markers on independent resume | Passed |
| Native Claude Code creates a persistent session and recalls a random marker on resume | Passed; session ID retained |
| Signed HTTP requests wake real Codex sessions through the receiver and native adapter | Passed with synthetic Slack events and captured output; two thread markers recalled after receiver restart, with distinct session IDs preserved |
| Native Codex invokes an existing Context7 MCP tool | Passed |
| Resumed native Codex reads the private thread using the existing Slack app connector and retrieves a marker absent from its prompt | Passed |
| Resumed native Codex posts one reply through that Slack connector containing both the thread marker and its original session marker | Passed; confirmed by reading the actual Slack thread |
| Settings at desktop and narrow mobile widths | Passed; no overflow or console errors in the tested flow |
| Settings preserves scoped bindings on instruction edits and reflects account/profile changes | Passed with a fixture identity |
| Public HTTPS tunnel reaches the real receiver health endpoint | Passed |
| Slack Events API automatically wakes a model session and receives its reply | Pending dedicated Slack test-app authorization |
| Live model execution in pi and omp | Not verified; those CLIs were unavailable here. Adapter output parsing and integration interfaces are covered offline |
| Arbitrary cloud or active-session harness bridge | Contract and offline bridges verified; a real bridge must be checked in its own environment |

The Slack app connection already present in a harness gives that session Slack tools. It does not expose a new app's signing secret or register event subscriptions for this receiver. The successful manual Slack checks therefore do not prove automatic event wake-up. That final check requires an installed Slack app, matching credentials, an enabled event subscription, and a public receiver URL.

## Repeat the live event check

Use a dedicated test identity/channel and explicitly authorize real model runs and Slack test messages.

1. Connect the test Slack app and configure its Events API request URL. Check Slack's URL verification succeeds.
2. Create an enabled native profile with `session_scope: "thread"` and a channel-only `mentions_and_replies` rule. Invite the bot to that channel.
3. From a different Slack identity, mention the bot in two separate root messages, giving each a distinct random marker. Confirm two completed deliveries and two distinct saved session IDs.
4. Reply in each thread without a mention and ask for its marker without repeating it. Confirm the replies recall the correct marker and retain the corresponding session ID.
5. Restart the receiver; repeat the recalls. Check an unmentioned root is ignored, an explicit channel `off` rule wins, pause suppresses new work, and bot replies do not trigger loops.
6. Ask the session to use an existing harmless connector tool and confirm its actual result. Inspect the harness trace if available.

Report the actual Slack replies and delivery/session records separately from fixture tests. A connected account or healthy tunnel alone does not complete this check.
