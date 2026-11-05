import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  }
}

// Diffs and notes are for reading, not type-checking: silence TS/JS diagnostics.
const tsDefaults = (monaco.languages as any).typescript
if (tsDefaults) {
  for (const d of [tsDefaults.typescriptDefaults, tsDefaults.javascriptDefaults]) {
    d?.setDiagnosticsOptions?.({ noSemanticValidation: true, noSyntaxValidation: true })
  }
}

monaco.editor.defineTheme('cw-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#1e1e1e',
    'editorCursor.foreground': '#f59e0b',
    'editor.lineHighlightBackground': '#2a2a2a',
    'editorLineNumber.activeForeground': '#f59e0b',
    'editor.selectionBackground': '#f59e0b40',
    'editor.inactiveSelectionBackground': '#f59e0b20',
    'focusBorder': '#f59e0b80'
  }
})

monaco.editor.defineTheme('cw-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editorCursor.foreground': '#b45309',
    'editorLineNumber.activeForeground': '#b45309',
    'editor.selectionBackground': '#f59e0b40',
    'focusBorder': '#d9770680'
  }
})

export { languageFor } from './monacoLang'
export { monaco }
