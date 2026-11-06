# Implementation notes

The connector uses local rule matching, explicit mention checks, private/DM scope boundaries, self-message filtering, durable channel/timestamp deduplication, commit-before-acknowledgement, and queued work while sessions are busy. Signed HTTP Events API requests provide its Slack webhook.

This implementation is independent JavaScript using Node's SQLite module and the official MCP SDK. It does not import Kindred's database, runtime, bot scheduler, credentials, or UI.

Session bindings are durable mappings from profiles, channels, or Slack threads to harness-owned session IDs. Participation in a thread belongs to the teammate profile that replied. The queue retains order across backoff, callback waits, and failures. Account replacement pauses profiles and clears context bindings. Database migration preserves v0.1 credentials, fixed session IDs, and delivery history.

Harness-neutral HTTP and command adapters use the same envelope. Built-in local CLI adapters translate it to Claude Code print/resume, Codex exec/resume, or pi/omp JSON print mode, preserving configured harness tools and connectors. Native configuration arguments can select a harness profile or settings file. Automated parser checks use fixtures. Separate manual Codex checks exercised real model recall and existing connectors; see [validation](validation.md).

The installer registers MCP for Claude Code/Codex and packages the same management tools as native pi/omp extensions. All routes use the same authenticated receiver API. A per-profile runtime record lets the receiver use Node 24 when the hosting harness uses Bun or another runtime.

GitHub distributes the source and install instructions. The receiver and installed source report the same package version. Installation detects mismatches and can gracefully restart an idle compatible receiver; older receivers require an explicit process-manager restart. This repository does not provision a hosted SaaS receiver or a Slack app. A live installation needs its Slack app credentials, public receiver URL, and a reachable harness. Live Slack event delivery, authorship/scopes, and model authentication require an installation-specific smoke test.
