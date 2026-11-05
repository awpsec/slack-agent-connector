# Slack Agent Connector

Give a persistent agent session a seat in Slack. New Slack events wake the session, it uses the tools and connectors in its own harness, and the connector posts its reply as the connected Slack identity.

## Install with one prompt

Paste this into Claude Code, Codex, pi, omp, or another coding agent:

```text
Install https://github.com/awpsec/slack-agent-connector for this harness.
Follow its INSTALL.md, perform the installation, and begin Slack setup.
Give me the private settings link when it is ready.
```

The agent installs the connector, registers it with the current harness, starts its receiver, and opens private setup. You do not need to copy terminal commands or configure MCP by hand. [INSTALL.md](INSTALL.md) contains the exact instructions the agent follows.

| Harness | Installation | Session execution |
| --- | --- | --- |
| Claude Code | User-scoped MCP registration | Native print/resume adapter |
| Codex | MCP registration | Native exec/resume adapter |
| pi | Native extension package and `/slack-setup` | Native JSON/print session adapter |
| omp | Native extension package and `/slack-setup` | Native JSON/print session adapter |
| Other MCP clients | Generated MCP configuration for the agent to register | Any webhook or JSON command bridge |
| Other harnesses | HTTP management API and the documented bridge contract | Any webhook or JSON command bridge |

Installing the software and beginning setup need only that prompt. Activating Slack still requires your Slack app authorization/credentials and a public HTTPS receiver URL. Enter secrets in the private settings form, never in the prompt. The installer leaves a new teammate profile disabled until its connection and channel rules are ready.

## What it does

The core speaks a small JSON contract over **webhooks or command stdin/stdout**. Any harness can implement that contract. Claude Code, Codex, pi, and omp have convenience adapters. A cloud session and a local session use the same profile and event model; the harness decides where the session runs. The connector runs independently of Kindred.

## Manual installation

Requires Node.js 24 or newer.

```sh
git clone https://github.com/awpsec/slack-agent-connector.git
cd slack-agent-connector
npm ci --ignore-scripts
node bin/slack-agent.mjs install --harness codex --cwd /absolute/path/to/your/project
```

Replace `codex` with `claude`, `pi`, `omp`, or `mcp`. Open the settings link printed in the terminal. It expires after five minutes and can be used once. The receiver stays running independently of an interactive agent conversation. No npm publication is required; GitHub is the installation source.

`--dry-run` prints an installation plan without changing client settings. `--no-start` registers the integration without starting a receiver. Re-running installation preserves existing teammate profiles and skips an identical MCP registration. A conflicting MCP name is not overwritten; use a different `--profile`.

For a dedicated foreground receiver, use `npm start` or the `serve` command below.

The default receiver is `http://127.0.0.1:4037`. For a different port or isolated Slack account:

```sh
node bin/slack-agent.mjs serve --profile sandor --port 4038
node bin/slack-agent.mjs settings --profile sandor
```

Each `--profile` has its own Slack credentials, settings, queue, and receiver. Names use letters, numbers, and underscores. One receiver connects one Slack identity; its teammate profiles can target different sessions or channels. Use separate named receiver profiles for separate Slack identities.

## Manual MCP registration

The installer handles this step. To register it yourself instead, replace `/absolute/path` with this checkout's location:

```sh
claude mcp add --scope user --transport stdio slack-agent -- node /absolute/path/slack-agent-connector/bin/slack-agent.mjs mcp --profile sandor
codex mcp add slack-agent -- node /absolute/path/slack-agent-connector/bin/slack-agent.mjs mcp --profile sandor
```

For other MCP harnesses, generate the configuration:

```sh
node bin/slack-agent.mjs config --profile sandor
```

That prints both MCP JSON and Codex TOML, with absolute executable and data paths. The MCP process starts the receiver if necessary. On first automatic start it selects a free port; later starts reuse that port. For a reverse proxy, explicitly run `serve` on a fixed port and keep it running through your process manager. MCP's `--no-autostart` option can require an already running receiver.

Then ask your agent:

> Set up Slack monitoring for Sandor. Give me the settings link and webhook. Use my existing harness session, respond to mentions across available channels, and wake on every message in engineering but reply only when relevant.

The agent calls `slack_setup`, discovers channels with `slack_channels`, and saves the requested session target and rules with `slack_assignment_save`. Secrets go in the settings form. The tools never return stored Slack tokens, signing secrets, or harness bearer tokens.

The settings page exposes the same profiles, session IDs, instructions, channel overrides, pause controls, and delivery history. MCP gives the harness a settings link; it does not install a new native settings panel inside the host application.

## Native pi and omp tools

The installer generates a package bound to the chosen connector data directory and installs it using `pi install` or `omp install`. The repository also declares `pi.extensions` and `omp.extensions` for package managers. No separate third-party MCP adapter is required for these two harnesses.

After `/reload` or a restart, use `/slack-setup`, or ask the agent to call `slack_setup`. The extension registers the same profile/channel/setup tools as MCP, plus `slack_current_session` to inspect the harness's current session ID and working directory. The receiver always uses the Node 24 runtime saved by the installer, even if the host runs on Bun.

The native session adapters run dedicated noninteractive sessions with the project's existing tools/extensions. Do not run a second CLI process against a session that is already open in another process; use a dedicated teammate session or your harness's active-session bridge for that case.

## Connect Slack

1. Create or use a Slack app and install it in the intended workspace. Use a bot OAuth token (`xoxb-…`) for an app bot, or a user OAuth token (`xoxp-…`) for a dedicated account such as Sandor. Replies use that authenticated identity; setting a profile name does not change Slack authorship.
2. In **Slack account**, enter the OAuth token and app signing secret. An optional app ID further restricts event validation. The connector verifies the account with `auth.test`.
3. Provide a dedicated public HTTPS hostname and point its reverse proxy or tunnel at this receiver. The generated **Slack Events API request URL** goes in the Slack app's Event Subscriptions settings. This is an Events API receiver, rather than a Slack Incoming Webhook for posting messages.
4. Download the generated app manifest. It lists the message subscriptions and OAuth scopes for the selected user or bot token. Apply the scopes/events to the app and reinstall if needed. For a new app, token and signing-secret creation still happen in Slack's app management interface.
5. Invite the account/app to the selected conversations, save a teammate profile, then send it a mention.

Slack requires access to each conversation and the appropriate scopes. “All available channels” does not grant visibility into the whole workspace. Private channels and DMs remain subject to the connected identity's access. Message delivery is pushed by Slack; the connector does not poll Slack or replay channel history.

The settings page refreshes its own delivery status; this does not query Slack for new messages.

## A profile binds identity, session, and channel behavior

Choose a harness webhook, a JSON command, or a local Claude Code/Codex/pi/omp adapter. Set an existing session/thread ID, or leave it empty and let the harness return a new one. **Create session now** and `slack_session_start` dispatch `session.create`; a successful response binds the returned session ID before any Slack message arrives. An unbound profile may also acquire its session ID from its first message response.

The same session receives later events across that profile's channels. It can use the connectors and tools already configured in its harness. The connector does not copy those credentials or recreate those tools. Local convenience adapters inherit the CLI's existing configuration and authorization; they do not bypass permission checks. A cloud session must be continued through its harness's webhook/command bridge; a local CLI adapter cannot resume an arbitrary cloud session by ID.

| Behavior | When the session wakes |
| --- | --- |
| Off | Never |
| Every message | Each new human message |
| Mentions only | A literal Slack mention of the connected identity |
| Mentions and replies | A mention, or a reply in a thread this connector has participated in |

A channel-specific rule overrides the workspace rule, including **Off**. DMs have a separate rule. Each rule can add channel instructions. To answer when relevant, choose **Every message**, add that instruction, and have the harness return `{"reply":null}` when it should stay silent. Relevance is a model decision; a name written as plain text is not a literal Slack mention.

Other bots, self-authored messages, edits, and deletions do not wake sessions. Replies are posted in the originating thread. Available thread context is included; a scope or rate-limit failure while fetching context does not block delivery of the original event.

## Plug in any harness

See [the harness contract](docs/harness-contract.md) for the complete event, response, and callback formats. A harness bridge only needs to:

1. Accept `session.create` or `slack.message` JSON.
2. Create/continue the requested session in its own environment, using its own connectors.
3. Return `session_id` when creating a session and `reply` for a Slack response, or accept the job and call back later.

For a synchronous HTTP bridge, reply with HTTP 200 and `{"reply":"On it.","session_id":"your-session-id"}`. Return `{"reply":null}` to stay silent. For asynchronous jobs return HTTP 202, then complete the delivery using its scoped callback URL/token. Command bridges read one JSON object from stdin and write one reply object to stdout; logs belong on stderr.

The JSON interface is harness-independent. Native session creation, resumption, and connector access still require that harness to expose an execution interface or a bridge.

## Delivery behavior

Matching events are stored in SQLite before Slack receives an acknowledgement. A message's workspace/channel/timestamp is its durable identity, deduplicating Slack retries and overlapping `message`/`app_mention` events. Busy sessions queue work. Profiles targeting the same known session are serialized within one receiver; the harness must coordinate other callers of that session.

HTTP dispatch failures retry up to three times with the same delivery ID. Harness bridges must use it as an idempotency key, including across connector restarts. Failed or interrupted local command/CLI runs require an explicit retry because the process may already have used its harness tools. A saved reply is retried after a Slack rate limit without another model run. A timeout or interrupted process during a Slack post is marked **uncertain**, because Slack may already have accepted the message. Check Slack before using the explicit retry control.

Pause, profile edits, removal, and account replacement cancel pending events, including late callbacks. A Slack API request already submitted when a setting changes cannot be recalled. Resume processes new events and does not scan history. Async callbacks expire after 30 minutes. Old deliveries and their deduplication records are retained in this initial version; apply an operational retention policy for a long-running high-volume installation.

Credentials and event data are stored in the private data directory, with owner-only filesystem permissions. Bind to localhost behind an HTTPS proxy. The generated callback address must be reachable by the harness; remote harnesses need the public base URL. There is no hosted receiver, Slack app provisioning service, or OAuth app registration bundled into this checkout.

## Verify

```sh
npm test
npm run check
```

Tests exercise installation plans, MCP registration preservation, native extension schemas, private setup, signed HTTP ingestion, an actual stdio MCP client, synchronous and asynchronous harness responses, session binding, pause/edit races, durable deduplication and restart recovery. They use fake Slack responses and do not send real Slack messages or start paid model runs. The browser flow was also checked with a test identity and a local command bridge. Native model output parsers are tested with representative JSON events; live model/authentication behavior requires a smoke test in the user's installation.

## Remove or change an installation

Use your harness's MCP removal command or package manager to remove the integration. This does not delete your profile data or stop a separately running receiver. Stop that receiver when retiring a Slack identity. Keep profile data if you want to reinstall and retain rules, queue history, and credentials.

Install another isolated identity with the same prompt and a requested `--profile` name. Existing client settings and connector profiles remain intact.

## License

MIT. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).

References: [Slack Events API](https://docs.slack.dev/apis/events-api/), [Slack request signing](https://docs.slack.dev/authentication/verifying-requests-from-slack/), [Claude Code MCP](https://code.claude.com/docs/en/mcp), [Claude Code session resumption](https://code.claude.com/docs/en/headless), [official OpenAI documentation for MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Codex noninteractive sessions](https://learn.chatgpt.com/docs/non-interactive-mode), [pi packages](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md), and [omp extension packages](https://github.com/can1357/oh-my-pi/blob/main/docs/skills/authoring-extensions.md).
