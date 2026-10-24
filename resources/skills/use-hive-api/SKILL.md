---
name: use-hive-api
description: "Call Hive's local HTTP API from a script or tool, or debug a hive tool against it. Use only when automating Hive over HTTP: for ordinary board, notes and handover work the hive tools are enough."
metadata:
  audience: agents
---

# Use Hive's API

The hive tools wrap this API. Use HTTP only for what they don't cover: a script, a test harness, an integration, or debugging a tool.

## Connect

- Sessions started from Hive have `HIVE_API_URL` and `HIVE_API_TOKEN_FILE` (a JSON file whose `token` is this agent's own token for this launch), and also `HIVE_API_TOKEN`.
- Read the token inside the command that uses it. Never print it, log it, or write it into files or notes. For example, in PowerShell: `$t = (Get-Content $env:HIVE_API_TOKEN_FILE | ConvertFrom-Json).token; Invoke-RestMethod "$env:HIVE_API_URL/v1/status" -Headers @{ Authorization = "Bearer $t" }`.
- With several Hive windows open, name the workspace with the `X-Hive-Workspace` header (its path, URL-encoded). An agent's own token always means its own workspace.

## Discover before you call

`GET /v1/status` gives `app.version`, `api.version`, `caller` (who Hive takes you for, and your scope) and `guidance` (the revision of the guidance and skills it ships). `GET /v1/docs/agent-api` is the full reference for this version, as Markdown: read the section you need rather than guess routes or fields.

## Read lean

Ask for what the task needs: `GET /v1/tasks?view=short` for card rows, `?history=false`, `?comments=5` or `/comments/latest` on a card, `?view=short` on projects, and the activity summary unless you need `?detail=true`.

A card's steps are its intents, `POST /v1/tasks/{card}/<intent>` (the reference lists them).

## Errors

Errors come as `{ "error": "message" }`. Each message says what to do.

- `400`: fix the request.
- `401`: the token is wrong or ended (the agent restarted): read the token file again.
- `403`: not allowed for you. Don't look for another way in.
- `404`: not found, or outside your scope.
- `409`: conflicts with the current state (busy, already running, changed meanwhile): read the state again before deciding. A workflow refusal (`refused: true`) also names its `rule` and `next` step: take it.
- `429`: too many at once: let some end first.

Don't repeat a change whose result you didn't see (a timeout, a dropped connection) until you have read the state and know it didn't.

## Stay in scope

Your token limits you to your project's cards and agents. Never use the workspace token from Settings or `agent-api.json` to get round that, nor to do what a missing hive tool, a busy agent, the user's input or a refusal stopped. Tell the user instead.
