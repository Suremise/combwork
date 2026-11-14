---
name: add-or-change-provider
description: Add a coding-agent provider to Combwork or change how one is supported (Claude Code, Codex) - its shared half and adapter, their capability parts, launch, hooks, transcripts, usage, skills and MCP delivery, readiness and tests. Use when developing Combwork and a change touches src/shared/providers/, src/main/providers/, or how a CLI is launched or read.
---

# Add or change a provider

Each provider lives in two folders of its own behind one registry line, and nothing else names it (HI-3201). [SPEC §10](../../../docs/SPEC.md) describes the boundary; the [architecture notes](../../../docs/ARCHITECTURE.md) say where each part lives.

## The shape

- **The registry** (`src/shared/providers/registry.ts`): one line per provider, in display order (the first is the default). Adding a provider is its two folders and a line; removing one is the same three.
- **Its shared half** (`src/shared/providers/<folder>/`, renderer-safe: no Node, no Electron, nothing from `src/main`): `index.ts` exports `defineProvider({ descriptor, prices, tips, safeguards, advanced, outageCheck, adminSnippet })`. The descriptor holds names, badge, permission modes, effort levels, models and `capabilities`. Shared code reads all of it only through `src/shared/providers`' helpers (`providerDescriptor`, `providerModule`, `PROVIDERS`), `prices.ts`, `tips.ts`, `advanced.ts` and `safeguards.ts`, which gather it from the registry.
- **Its main half** (`src/main/providers/<folder>/`): `adapter.ts` default-exports the adapter, which `src/main/providers/index.ts` finds by folder and orders by the registry. `worker.ts` holds what threads read without Electron (its usage parser, its threads' names). `threads/*.ts` are its own worker threads, built as `<folder>-<name>`.
- **Capability parts**: the adapter (`ProviderAdapter` in `types.ts`) is `install` and `launch`, which every provider has, plus the optional parts it supports: `hooks`, `status`, `terminal`, `modes`, `transcript`, `usage`, `accounts`, `githubHost`, `models`, `compaction`, `projectFiles`, `background`, `lifecycle` and `adminSnippet`. A class adapter implements a part's members itself and names it present with a getter that returns itself. The descriptor's `capabilities` are parts too (`terminal`, `session`, `modes`, `usage`, `compaction`, `background`, `hooks`, plus `githubHost` and `connections`). An absent part means none of it, and its callers do without it: write the fallback where you read a part.
- A provider's folders never import another's: what two share goes in `src/shared/providers/common.ts` or `src/main/providers/` (`common.ts`, `conversation.ts`, `localData.ts`). Shared code never imports `src/main`.
- The rules every provider change keeps (no provider named outside its folders, never a CLI's own config files, a CLI's text and timeouts as advanced settings) are AGENTS.md's (Gotchas: Providers and the advanced settings). `tests/providerRegistry.test.ts` fails on a provider named outside its folders, on a cross-provider or shared-to-main import, and on folders that don't match the registry.

## Checklist

1. **Shared half**: the descriptor (modes with danger flags, efforts, models, its capability parts, the instructions file, its badge), its prices from the vendor's current published ones, its tips, and its advanced values with recorded samples (`advanced.ts` in its folder, built from `src/shared/advancedDef.ts`). Then its registry line.
2. **Launch**: per-agent launch folder or copies (skills by audience, the `combwork` MCP server, `TOOLS_SERVER`, hooks), the environment Combwork adds, and the provider's own session variables stripped (`install.envToStrip`). Combwork's guidance reaches the model: MCP instructions where the CLI shows them, developer instructions where it doesn't.
3. **Status**: the `hooks` part normalises hooks to start, prompt, tool, permission, stop and end. Know which events the CLI actually sends and when (Codex sends SessionStart only with the first prompt). A status line is the `status` part.
4. **Transcripts and usage**: the `transcript` and `usage` parts (the parser, the conversation reader, images and export) and `worker.ts`' usage parser, tested against **fixtures** in `tests/fixtures` made from real transcripts with personal text removed.
5. **Readiness**: installed, signed in, sandbox. Never automate a login screen; tell the user what to do.
6. **Skills and MCP**: the `projectFiles` part: where the CLI reads skills (`skillRoots`), how Combwork's copies are marked and kept out of git, and how the user's own MCP servers are turned off.

## Facts that change

CLI flags, hook payloads, model names and prices change between versions. Check the vendor's current documentation and the installed CLI (`--help`, its changelog) for what your change relies on, and write the version you checked against in a comment or test name. Don't copy prices or version numbers into prose like this.

## Testing

- Unit tests for the parsers and the launch command (`tests/codex.test.ts` is the model), including hook trust hashes where the CLI checks them. `tests/providerRegistry.test.ts` checks the registry.
- The fake CLIs in `tests/e2e` exercise the adapter without sign-in. Extend a fake when a behaviour matters. A provider's fake should take the scenarios' steps (`skill NAME`, the board steps, `cw TOOL {json}` through `tests/e2e/fake-bridge.cjs`), so `npm run scenarios -- --provider fake-<id>` runs the scenarios and their benchmark for it. Real-CLI suites run against test homes only (Codex: `CODEX_HOME` set to the test home).
- A test that bundles main's code with esbuild takes `tests/esbuildGlob.ts`' plugin: the registry finds adapters and workers by `import.meta.glob`.
- Check Windows path handling: spaces, `.cmd` shims, quoting on the command line.
