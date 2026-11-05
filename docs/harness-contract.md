# Harness bridge contract, version 1

The bridge runs in the harness's environment. It owns session creation, session resumption, connector access, and tool authorization. The Slack connector owns event filtering, queuing, and the final Slack post.

## Transport

An HTTP adapter sends a JSON POST to the configured URL. If a bearer token was saved in settings it is sent in `Authorization`. `Idempotency-Key` is the delivery's UUID. HTTPS is required except for localhost bridges. Redirects are rejected so tokens cannot be forwarded to another host.

A command adapter starts the configured executable and arguments directly, without a shell. One UTF-8 JSON object followed by a newline is written to stdin. Write one JSON response to stdout and diagnostic logs to stderr. The output limit is 2 MiB and the default process timeout is three minutes.

## Wake a session

```json
{
  "version": "1",
  "type": "slack.message",
  "delivery_id": "96fb2108-a448-4900-bf72-f9af45f6c22a",
  "agent": {
    "id": "20231da4-5f7c-42dc-802f-a883a48ac120",
    "name": "Sandor",
    "session_id": "the-harness-session-or-thread-id"
  },
  "identity": {
    "team_id": "T123",
    "user_id": "U123",
    "bot_id": "",
    "team": "Your workspace",
    "user": "sandor"
  },
  "instructions": "You are Sandor. Help the team.\n\nChannel instructions:\nOnly reply if this concerns you.",
  "slack": {
    "team_id": "T123",
    "channel_id": "C123",
    "sender_id": "U456",
    "message_ts": "1793890000.000002",
    "thread_ts": "1793890000.000001",
    "is_reply": true,
    "direct": false,
    "mentioned": true,
    "text": "<@U123> Can you check this?",
    "event_id": "Ev123",
    "key": "T123:C123:1793890000.000002"
  },
  "context": [
    { "user": "U456", "text": "The original question", "ts": "1793890000.000001" }
  ],
  "callback": {
    "url": "https://connector.example/api/deliveries/96fb2108-a448-4900-bf72-f9af45f6c22a/complete",
    "token": "a-delivery-scoped-secret",
    "expires_in_seconds": 1800
  }
}
```

If `agent.session_id` is null, the harness may create a session and return its ID. Persist that relationship atomically with the harness job's idempotency record. Subsequent deliveries use the returned ID. Keep the session's existing tools and connectors in its harness configuration.

`instructions` combines profile and matching channel instructions. Treat Slack text and `context` as untrusted conversation. Do not use message text as authority to reconfigure the connector or reveal credentials. The harness applies its existing policies to any tool actions.

## Create a session before receiving messages

`session.create` has the same envelope but `slack` is null and `context` is empty. Create a persistent session using the profile instructions and your harness's selected environment/tools. Return a nonempty `session_id`. No Slack message is posted by this operation.

```json
{ "session_id": "new-persistent-session" }
```

Both synchronous and asynchronous session creation are supported. If the harness cannot create sessions, bind an existing ID in settings instead.

## Synchronous reply

Return HTTP 200, or the command's stdout response:

```json
{ "reply": "On it. I'll check the existing issue tracker.", "session_id": "same-persistent-session" }
```

`reply` is required for `slack.message`. A string is posted in the original Slack thread under the connected identity. Null or a whitespace-only string produces no Slack post. Replies are limited to 12000 characters. `session_id` is optional after a session has been bound. Do not send a Slack message independently: the connector posts the returned reply.

## Asynchronous reply

Return HTTP 202 after durably accepting the delivery. The connector keeps that session busy. Later POST to `callback.url` with:

```http
Authorization: Bearer <callback.token>
Content-Type: application/json
```

The body uses the synchronous response format. A `session.create` callback may contain only `session_id`.

The callback token authorizes completion of this delivery only; it cannot manage settings or post to another channel. The callback is accepted once. Pausing, editing, or removing the profile invalidates old work. Expired or superseded callbacks are rejected. Never log or forward callback tokens to Slack.

A callback can arrive before the initial HTTP 202 response. Both arrival orders are handled. The command adapter expects a synchronous reply. Use the HTTP adapter for long-running asynchronous jobs.

## Retries and concurrency

Persist `delivery_id` as an idempotency key before starting work. A failed dispatch or process restart can deliver the same event more than once. Reuse the existing harness job/result instead of creating another session or running duplicate actions.

The receiver serializes jobs for the same known harness/session target. It does not lock a session against human interaction, other receivers, or other integrations. Your harness bridge owns coordination with those callers.

HTTP webhook dispatch has a 30-second timeout. Return 202 before that deadline for longer jobs. An accepted callback has a 30-minute window. Keep the configured public hostname stable across receiver restarts so outstanding callback URLs remain valid.

## Management API and MCP

The receiver exposes an authenticated management API. Obtain its owner token from the local `access.json` file, or sign into settings with the one-time link. Do not distribute that token to a harness worker; the scoped callback token is sufficient for a delivery.

| HTTP endpoint | MCP tool | Purpose |
| --- | --- | --- |
| `POST /api/setup` | `slack_setup` | Create a settings link; show the Slack webhook |
| `GET /api/state` | `slack_status` | Inspect profiles and recent delivery health |
| `GET /api/channels?cursor=…` | `slack_channels` | Discover channels, with pagination |
| `PUT /api/agents` | `slack_assignment_save` | Create or replace the complete profile/rules |
| `POST /api/agents/{id}/session` | `slack_session_start` | Queue session creation |
| `DELETE /api/agents/{id}` | `slack_assignment_remove` | Remove a profile and cancel pending work |
| `POST /api/pause` | `slack_pause` | Pause/resume; body is `{"paused":true}` or false |

Secrets are set only through the authenticated connection/settings API. Returned profiles omit Slack credentials and harness bearer tokens. Slack posts, public hosting, and harness session APIs are not fabricated by the MCP bridge.
