import { useEffect, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import { useStore } from '../store'

type MonacoModule = typeof import('../monaco')
let monacoPromise: Promise<MonacoModule> | null = null
function loadMonaco(): Promise<MonacoModule> {
  monacoPromise ??= import('../monaco')
  return monacoPromise
}

function useEditorTheme(): string {
  const theme = useStore((s) => s.settings?.appearance.theme)
  const [dark, setDark] = useState(document.documentElement.dataset.theme !== 'light')
  useEffect(() => setDark(document.documentElement.dataset.theme !== 'light'), [theme])
  return dark ? 'cw-dark' : 'cw-light'
}

const baseOptions: Monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  minimap: { enabled: false },
  // i18n-ignore: font names, not text
  fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace",
  fontSize: 13,
  scrollBeyondLastLine: false,
  renderWhitespace: 'selection',
  smoothScrolling: true,
  padding: { top: 10 },
  fixedOverflowWidgets: true
}

/** A line (and column) to put the cursor on; a new nonce goes there again. */
export type EditorGoto = { line: number; col?: number; nonce: number }

/** Monaco text editor. Calls onSave on Ctrl+S. */
export function CodeEditor({
  value,
  language,
  onChange,
  onSave,
  readOnly,
  wordWrap = true,
  goto
}: {
  value: string
  language: string
  onChange?: (v: string) => void
  onSave?: () => void
  readOnly?: boolean
  wordWrap?: boolean
  goto?: EditorGoto
}) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const [ready, setReady] = useState(false)
  const theme = useEditorTheme()
  const cbs = useRef({ onChange, onSave })
  cbs.current = { onChange, onSave }
  const latest = useRef(value)
  latest.current = value
  // Values the editor reported itself. React can be a keystroke or two behind while typing, so
  // those must not be pushed back into the editor — that would drop the newer characters.
  const emitted = useRef<string[]>([])

  useEffect(() => {
    let disposed = false
    void loadMonaco().then(({ monaco }) => {
      if (disposed || !host.current) return
      const ed = monaco.editor.create(host.current, {
        ...baseOptions,
        value: latest.current,
        language,
        theme,
        readOnly,
        wordWrap: wordWrap ? 'on' : 'off'
      })
      ed.onDidChangeModelContent(() => {
        const v = ed.getValue()
        emitted.current.push(v)
        if (emitted.current.length > 50) emitted.current.shift()
        cbs.current.onChange?.(v)
      })
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => cbs.current.onSave?.())
      editor.current = ed
      setReady(true)
    })
    return () => {
      disposed = true
      // Dispose the editor before its model; the other order makes Monaco throw "Model is disposed!".
      const model = editor.current?.getModel()
      editor.current?.dispose()
      model?.dispose()
      editor.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const ed = editor.current
    if (!ed || emitted.current.includes(value) || ed.getValue() === value) return
    // A change from outside (reload, another file): replace the content.
    emitted.current = []
    ed.setValue(value)
  }, [value])

  useEffect(() => {
    void loadMonaco().then(({ monaco }) => {
      const model = editor.current?.getModel()
      if (model && !model.isDisposed()) monaco.editor.setModelLanguage(model, language)
      monaco.editor.setTheme(theme)
    })
  }, [language, theme])

  useEffect(() => editor.current?.updateOptions({ readOnly, wordWrap: wordWrap ? 'on' : 'off' }), [readOnly, wordWrap])

  useEffect(() => {
    const ed = editor.current
    const model = ed?.getModel()
    if (!ed || !model || !goto) return
    const lineNumber = Math.min(Math.max(1, goto.line), model.getLineCount())
    const column = Math.min(Math.max(1, goto.col ?? 1), model.getLineMaxColumn(lineNumber))
    ed.setPosition({ lineNumber, column })
    ed.revealLineInCenter(lineNumber)
    ed.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, goto?.nonce])

  return <div className="monaco" ref={host} />
}

/** Side-by-side (or inline) read-only diff. */
export function DiffView({ original, modified, language, inline }: { original: string; modified: string; language: string; inline?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null)
  const theme = useEditorTheme()

  useEffect(() => {
    let disposed = false
    void loadMonaco().then(({ monaco }) => {
      if (disposed || !host.current) return
      editor.current = monaco.editor.createDiffEditor(host.current, {
        ...baseOptions,
        readOnly: true,
        originalEditable: false,
        renderSideBySide: !inline,
        theme,
        ignoreTrimWhitespace: false,
        // The gutter's revert/stage menu has no use in a read-only diff, and it keeps listening for
        // menu changes after the editor is disposed ("AbstractContextKeyService has been disposed").
        renderGutterMenu: false
      })
    })
    return () => {
      disposed = true
      const e = editor.current
      if (e) {
        const m = e.getModel()
        e.dispose()
        m?.original.dispose()
        m?.modified.dispose()
      }
      editor.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let cancelled = false
    void loadMonaco().then(({ monaco }) => {
      const e = editor.current
      if (cancelled || !e) return
      const old = e.getModel()
      e.setModel({ original: monaco.editor.createModel(original, language), modified: monaco.editor.createModel(modified, language) })
      // Monaco may still be diffing the old pair; disposing it straight away throws "has been disposed".
      setTimeout(() => {
        old?.original.dispose()
        old?.modified.dispose()
      }, 1000)
    })
    return () => {
      cancelled = true
    }
  }, [original, modified, language])

  useEffect(() => {
    void loadMonaco().then(({ monaco }) => monaco.editor.setTheme(theme))
    editor.current?.updateOptions({ renderSideBySide: !inline })
  }, [theme, inline])

  return <div className="monaco" ref={host} />
}

export { loadMonaco }
