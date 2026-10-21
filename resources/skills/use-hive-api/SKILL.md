---
name: use-hive-api
description: "Call Hive's local HTTP API from a script or tool, or debug a hive tool against it. Use only when automating Hive over HTTP: for ordinary board, notes and handover work the hive tools are enough."
metadata:
  audience: agents
---

# Use Hive's API

The hive tools wrap this API. Use HTTP only for what they don't cover: a script, a test harness, an integration, or debugging a tool's behaviour.

## Connect

- Sessions started from Hive have `HIVE_API_URL` and `HIVE_API_TOKEN_FILE` (a JSON file whose `token` is this agent's own token for this launch), and also `HIVE_API_TOKEN`.
- Read the token inside the command that uses it. Never print it, log it, or write it into files or notes. For example, in PowerShell: `$t = (Get-Content $env:HIVE_API_TOKEN_FILE | ConvertFrom-Json).token; Invoke-RestMethod "$env:HIVE_API_URL/v1/status" -Headers @{ Authorization = "Bearer $t" }`.
- With several Hive windows open, name the workspace with the `X-Hive-Workspace` header (its path, URL-encoded). An agent's own token always means its own workspace.

## Discover before you call

`GET /v1/status` says what is running:

- `app.version` and `api.version`;
- `caller`: who Hive takes you for, and your scope;
- `guidance`: the revision of the guidance and skills this Hive ships.

`GET /v1/docs/agent-api` returns the full API reference for this running version, as Markdown. Read the section you need, rather than guessing routes or fields.

## Read lean

Ask for what the task needs:

- `GET /v1/tasks?view=short` for card rows;
- `?history=false` or `?comments=5` on a card, or `/comments/latest` for the newest comment;
- `?view=short` on projects;
- the activity summary unless you need `?detail=true`.

## Errors

Errors come as `{ "error": "message" }`. Each message says what to do.

- `400`: the request is wrong; fix it.
- `401`: the token is wrong or ended (the agent restarted): read the token file again.
- `403`: not allowed for you. Don't look for another way in.
- `404`: not found, or outside your scope (another project's card looks missing to you).
- `409`: conflicts with the current state (busy, already running, changed meanwhile): read the state again before deciding.
- `429`: too many at once (such as card waits running): let them end first.

Don't repeat a change whose result you didn't see (a timeout, a dropped connection) until you have read the state and know it didn't happen.

## Stay in scope

Your token limits you to your project's cards and agents. Never use the workspace token from Settings or `agent-api.json` to get round that, nor to do what a missing hive tool, a busy agent, the user's input or a refusal stopped. Tell the user instead.
