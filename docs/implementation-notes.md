# Implementation notes

The connector uses local rule matching, explicit mention checks, private/DM scope boundaries, self-message filtering, durable channel/timestamp deduplication, commit-before-acknowledgement, and queued work while sessions are busy. Signed HTTP Events API requests provide its Slack webhook.

This implementation is independent JavaScript using Node's SQLite module and the official MCP SDK. It does not import Kindred's database, runtime, bot scheduler, credentials, or UI.

Session binding is a durable mapping from profile to harness-owned session ID. Harness-neutral HTTP and command adapters use the same envelope. Built-in local CLI adapters translate that envelope to Claude Code print/resume, Codex exec/resume, or pi/omp JSON print mode, preserving configured harness tools and connectors. Parsers are verified with representative process responses, without launching model runs.

The installer registers MCP for Claude Code/Codex and packages the same management tools as native pi/omp extensions. All routes use the same authenticated receiver API. A per-profile runtime record lets the receiver use Node 24 when the hosting harness uses Bun or another runtime.

GitHub distributes the source and install instructions. This repository does not provision a hosted SaaS receiver or a Slack app. A live installation needs its Slack app credentials, public receiver URL, and a reachable harness. Live Slack authorship/scopes and real model session behavior require an installation-specific smoke test.
