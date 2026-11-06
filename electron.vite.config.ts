import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/** Monaco's own copy of DOMPurify, which its domSanitize.js imports by a relative path. */
const MONACO_DOMPURIFY = /[\\/]monaco-editor[\\/]esm[\\/]vs[\\/]base[\\/]browser[\\/]dompurify[\\/]dompurify\.js$/
const MONACO_SANITIZE = /[\\/]monaco-editor[\\/]esm[\\/]vs[\\/]base[\\/]browser[\\/]domSanitize\.js$/

/**
 * Monaco's DOMPurify is Combwork's (#1141). monaco-editor 0.57.0 bundles its own copy of DOMPurify 3.4.15 (two IN_PLACE
 * advisories: Monaco doesn't sanitise in place, but the copy ships) and never imports the dompurify package it lists, so
 * package.json's override alone wouldn't change what ships. Its one import, from vs/base/browser/domSanitize.js, is Combwork's
 * dompurify (3.4.17 since HI-2421, the same library two patches on) instead, and a build that would still take Monaco's
 * copy fails. The dev server's pre-bundled Monaco keeps its copy (development only). Remove this and the override once
 * Monaco bundles 3.4.17 or later: tests/monacoDompurify.test.ts fails then to say so.
 */
export function monacoDompurify(): Plugin {
  return {
    name: 'cw-monaco-dompurify',
    enforce: 'pre',
    resolveId(source: string, importer?: string) {
      if (source !== './dompurify/dompurify.js' || !importer || !MONACO_SANITIZE.test(importer)) return null
      return resolve(__dirname, 'node_modules/dompurify/dist/purify.es.mjs')
    },
    load(id: string) {
      if (MONACO_DOMPURIFY.test(id)) throw new Error(`Monaco's own DOMPurify would be bundled (${id}): see cw-monaco-dompurify in electron.vite.config.ts (#1141)`)
      return null
    }
  }
}

export default defineConfig({
  main: {
    // Agent text's formatter (HI-2433, shared/agentText/icu.ts) is bundled into the chunks, not loaded from node_modules:
    // cw-mcp.js and cw-progress.js run outside the asar, where they find only Node's built-ins and Combwork's chunks.
    plugins: [externalizeDepsPlugin({ exclude: ['intl-messageformat', '@formatjs/icu-messageformat-parser'] })],
    build: {
      rollupOptions: {
        // Electron's fs without its .asar handling, which main uses (#246): electron-vite externalises Node's built-ins
        // and Electron's own modules, not this one.
        external: ['original-fs', 'original-fs/promises'],
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // The scripts agents' sessions run, named for what agents see (HI-2463: cw-*), as their sources are.
          'cw-mcp': resolve(__dirname, 'src/main/mcp/cw-mcp.ts'),
          'cw-progress': resolve(__dirname, 'src/main/progressReporters/cw-progress.ts'),
          // The close commands' runner (HI-1368), run as Node outside the asar.
          'cw-close-runner': resolve(__dirname, 'src/main/closeCommand/cw-close-runner.ts'),
          // The usage history's worker thread (#1106).
          'usage-worker': resolve(__dirname, 'src/main/usageWorker.ts'),
          // The repository lock's worker thread (HI-1680).
          'repo-lock-worker': resolve(__dirname, 'src/main/repoLockWorker.ts'),
          // A None project's whole-project read (HI-2340).
          'none-baseline-worker': resolve(__dirname, 'src/main/noneBaselineWorker.ts'),
          // Git's worker thread, which starts its processes (HI-1783).
          'git-worker': resolve(__dirname, 'src/main/gitWorker.ts'),
          // The stall watchdog's thread (HI-1692).
          'stall-watchdog': resolve(__dirname, 'src/main/stallWatchdog.ts'),
          // The log's writer thread (HI-1730).
          'log-writer': resolve(__dirname, 'src/main/logWriter.ts'),
          // The WAL checkpoints' worker thread (HI-1691).
          'wal-checkpoint-worker': resolve(__dirname, 'src/main/walCheckpointWorker.ts'),
          // Codex's log's worker thread (HI-1972).
          'codex-log-worker': resolve(__dirname, 'src/main/codexLogWorker.ts'),
          // The 1.0 data folders' move to .combwork: its card rewrite (HI-2462).
          'cw-move-worker': resolve(__dirname, 'src/main/combworkMoveWorker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@docs': resolve(__dirname, 'docs'),
        '@root': resolve(__dirname)
      }
    },
    plugins: [
      react(),
      monacoDompurify(),
      {
        // Codicons' base rule (.codicon[class*='codicon-'] { font: 16px/1 codicon }) comes twice: from
        // @vscode/codicons at start, and from Monaco when an editor first loads. As plain CSS it ties with Combwork's own
        // icon sizes (.activity-btn .codicon …), so whichever loaded last won and every shell icon fell to 16px. Both
        // copies go in a cascade layer, below Combwork's (unlayered) styles: Combwork's icon rules win whatever loads when.
        name: 'cw-codicons-layer',
        enforce: 'pre',
        transform(code: string, id: string) {
          if (!/[\\/](?:@vscode[\\/]codicons[\\/]dist|ui[\\/]codicons[\\/]codicon)[\\/]codicon\.css(?:\?|$)/.test(id)) return null
          return { code: `@layer codicons {\n${code}\n}\n`, map: null }
        }
      },
      {
        // The dev server's hot reload needs ws: and localhost; a build connects to nothing.
        name: 'cw-production-csp',
        apply: 'build',
        transformIndexHtml: (html: string) => html.replace(" connect-src 'self' ws: http://localhost:*", " connect-src 'self'")
      }
    ],
    build: { chunkSizeWarningLimit: 8000 }
  }
})
