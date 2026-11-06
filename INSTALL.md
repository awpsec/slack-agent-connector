# Install and begin setup

These instructions are for the agent receiving this request:

> Install https://github.com/awpsec/slack-agent-connector for this harness and begin Slack setup.

Do the installation work yourself. Give the user the private setup link when it is ready. Do not stop at explaining shell commands for the user to run.

## 1. Identify the current harness and project

Keep the user's original project working directory. Use `claude`, `codex`, `pi`, or `omp` as appropriate for this conversation. For another MCP client, use `mcp` and register the generated MCP configuration through that client's supported setup mechanism. For a harness without MCP, use the HTTP/command interface described in `docs/harness-contract.md`.

Install only into the current harness unless the user requested additional clients. A connector profile name is optional; use `--profile NAME` consistently if the user requests an isolated Slack identity. Do not infer or overwrite an unrelated existing Slack integration.

## 2. Prepare a stable checkout and runtime

Use Node.js 24 or newer and Git. If the machine lacks a compatible Node runtime, use its existing runtime manager or standard installation method, then continue. Run the installer using the verified Node executable, including when the harness itself uses Bun. Do not launch the SQLite receiver with Bun.

Clone `https://github.com/awpsec/slack-agent-connector.git` into a stable user-owned directory outside the current project's working tree. For example, use `~/.local/share/slack-agent-connector/source` on Linux/macOS, or a directory under the user's Local AppData on Windows. An existing clean checkout of this repository can be updated with a fast-forward pull. Preserve local changes and check its origin before reusing it.

Install its dependencies with `npm ci --ignore-scripts` inside that checkout. npm package lifecycle scripts are not needed.

## 3. Install and start private setup

From the original project directory, run the following using absolute paths and the actual current harness name:

```text
node /absolute/path/to/slack-agent-connector/bin/slack-agent.mjs install --harness HARNESS --cwd /absolute/path/to/the/users/project --json
```

Use separate arguments when executing this command. Paths may contain spaces. Add `--profile NAME` if an isolated identity was requested. The supported names for `--harness` are `claude`, `codex`, `pi`, `omp`, and `mcp`.

The installer:

1. Registers a user-scoped MCP server for Claude Code/Codex, or installs a native extension package for pi/omp. It checks MCP name collisions and preserves unrelated configuration.
2. Saves the verified Node runtime for the background receiver.
3. Starts or reuses that profile's receiver.
4. Creates a disabled starter teammate profile for a supported native harness when the receiver has no profiles yet.
5. Returns a private settings link, a Slack event webhook URL, and any reload instructions.

For `mcp`, it writes `mcp-config.json` in the profile data directory. Register that configuration in the current MCP client before reporting integration complete. If the current client has no known registration interface, report that exact remaining step instead of claiming native integration.

An installed MCP server or extension may need a client reconnect, `/reload`, or a restart to expose its new tools. The private settings link works immediately, so begin setup in this turn even when the current harness has not reloaded.

## 4. Begin the Slack connection

Return the `setup.settings_url` as a clickable link. This link is single-use and expires after five minutes. Generate a fresh link with `node /absolute/path/to/bin/slack-agent.mjs settings` using the same profile/data arguments when needed.

The user enters their Slack OAuth token and app signing secret in that private form. Never ask them to paste those secrets into the conversation. They must authorize/install their Slack app in Slack; installation of this connector does not provision a Slack app or grant workspace permissions.

Explain that the webhook must have a public HTTPS base URL before Slack can deliver events. The user can supply an existing hostname or tunnel; continue any hosting setup they explicitly request. Do not report local installation as live Slack activation.

Use the user's requested channels, wake behavior, teammate instructions, and session choice to configure the profile through the connector tools/settings. Enable the profile when that setup is complete. If the user has not chosen those preferences yet, begin with the settings link and ask only for the missing preferences. Do not start a paid model turn merely to test installation.

Choose `session_scope` to match the requested context: `profile` shares one session, `channel` separates channels/DMs, and `thread` separates Slack threads. Channel/thread scope leaves `session_id` empty and creates bindings on the first matching message. When editing an existing profile, omit `session_id` to preserve its current binding. Clear a bound profile session only when a fresh session was requested, by sending both `session_id: ""` and `reset_session: true`.

## 5. Verify the result

Verify the installed registration and that `/api/state` on the local receiver responds using the local owner credentials. Do not print or copy those credentials into the conversation. Native pi/omp tools use the same management API as MCP, plus `slack_current_session` to inspect their current session ID.

Summarize the harness registration, the private setup link, and the exact remaining Slack connection step. Once connected, a real Slack mention is the final delivery check. Session execution uses the harness's existing tools and connectors; a separate cloud service is not required.

When updating an existing installation, re-run the installer from the updated checkout. A source/receiver version mismatch is an error until the receiver restarts. The installer upgrades an idle receiver when its shutdown endpoint is available. Resolve pending work first. For v0.1 receivers, stop the original foreground process or use its process manager, then re-run installation; do not kill an unverified PID. `slack-agent stop` gracefully stops receivers that support the shutdown endpoint and retains their profile data.
