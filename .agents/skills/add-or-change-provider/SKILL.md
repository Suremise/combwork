---
name: add-or-change-provider
description: Add a coding-agent provider to Combwork or change how one is supported (Claude Code, Codex) - its descriptor, adapter, launch, hooks, transcripts, usage, skills and MCP delivery, readiness and tests. Use when developing Combwork and a change touches src/shared/providers.ts, src/main/providers/, or how a CLI is launched or read.
---

# Add or change a provider

Combwork works with providers through two pieces and never names one outside them. [SPEC §10](../../../docs/SPEC.md) describes the boundary; the [architecture notes](../../../docs/ARCHITECTURE.md) say where each part lives.

## The boundary

- **Descriptor** (`src/shared/providers.ts`): static data both processes use. Names, icon, permission modes, effort levels, models and `capabilities`.
- **Adapter** (`src/main/providers/<id>/`, the `ProviderAdapter` interface in `types.ts`): everything that runs. Locating the CLI and its readiness, setup tasks, `prepareLaunch` and `buildCommand`, hook normalisation, live details, transcripts and usage, skill folders, and the project's own MCP servers.
- The rules every provider change keeps (no provider id in shared code or the UI, never a CLI's own config files, a CLI's text and timeouts as advanced settings) are AGENTS.md's (Gotchas: Providers and the advanced settings).

## Checklist

1. **Descriptor**: modes (with danger flags), efforts, models, capabilities, and the instructions file. Register it, add its icon, and add a price table in `src/shared/prices.ts`, from the vendor's current published prices.
2. **Launch**: per-agent launch folder or copies (skills by audience, the `combwork` MCP server, `TOOLS_SERVER`, hooks), the environment Combwork adds, and the provider's own session variables stripped (`envToStrip`). Combwork's guidance reaches the model: MCP instructions where the CLI shows them, developer instructions where it doesn't.
3. **Status**: hooks normalised to start, prompt, tool, permission, stop and end. Know which events the CLI actually sends and when (Codex sends SessionStart only with the first prompt).
4. **Transcripts and usage**: the parser, the conversation reader, images and export, tested against **fixtures** in `tests/fixtures` made from real transcripts with personal text removed.
5. **Readiness**: installed, signed in, sandbox. Never automate a login screen; tell the user what to do.
6. **Skills and MCP**: where the CLI reads skills (`skillRoots`), how Combwork's copies are marked and kept out of git, and how the user's own MCP servers are turned off.

## Facts that change

CLI flags, hook payloads, model names and prices change between versions. Check the vendor's current documentation and the installed CLI (`--help`, its changelog) for what your change relies on, and write the version you checked against in a comment or test name. Don't copy prices or version numbers into prose like this.

## Testing

- Unit tests for the parsers and the launch command (`tests/codex.test.ts` is the model), including hook trust hashes where the CLI checks them.
- The fake CLIs in `tests/e2e` exercise the adapter without sign-in. Extend a fake when a behaviour matters. A provider's fake should take the scenarios' steps (`skill NAME`, the board steps, `hive TOOL {json}` through `tests/e2e/fake-bridge.cjs`), so `npm run scenarios -- --provider fake-<id>` runs the scenarios and their benchmark for it. Real-CLI suites run against test homes only (Codex: `CODEX_HOME` set to the test home).
- Check Windows path handling: spaces, `.cmd` shims, quoting on the command line.
