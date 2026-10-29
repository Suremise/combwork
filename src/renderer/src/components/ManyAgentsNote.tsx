import { useEffect, useState } from 'react'
import { manyAgentsNote } from '@shared/defaults'
import { call } from '../api'
import { Icon } from './ui'

/**
 * Maximum agents over the default (#562, HI-2001: Version Control → Workflow; before, Settings → Advanced's Agents per
 * project): what more agents cost, in this machine's figures, measured as it shows.
 */
export function ManyAgentsNote() {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void call('agents:memory')
      .then((m) => live && setText(manyAgentsNote(m)))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  if (!text) return null
  return (
    <div className="advanced-note" data-note="many-agents">
      <Icon name="info" /> {text}
    </div>
  )
}
