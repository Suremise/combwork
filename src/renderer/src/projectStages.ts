import { useEffect, useMemo } from 'react'
import type { ProjectStages } from '@shared/types'
import { useScopedLoad } from './scopedLoad'
import { NO_PROJECTS, useStore } from './store'

// Each project's stages as its options produce them, and its names for them (#1417's `workflow:stages`), for the views
// that name a card's stage (the Progress panel's lanes and legend, #1421). Read again on `workflow-changed`.

/** The workspace's projects' stages, by path in lower case (as the window's lanes name them); none while a project's version control isn't recorded. */
export function useProjectStages(): Map<string, ProjectStages> {
  const ws = useStore((s) => s.workspace?.path ?? '')
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  const version = useStore((s) => s.workflowVersion)
  const key = projects
    .filter((p) => p.platform)
    .map((p) => p.path)
    .join('\n')
  const scope = `${ws}\n${key}`
  const { data, load } = useScopedLoad<[string, ProjectStages][]>(scope)
  useEffect(() => {
    if (!ws) return
    const paths = key ? key.split('\n') : []
    load(scope, async () => {
      const got = await Promise.all(paths.map(async (path) => [path.toLowerCase(), await window.hive.invoke('workflow:stages', path)] as const))
      return got.filter((x): x is [string, ProjectStages] => !!x[1])
    })
  }, [scope, ws, key, version, load])
  return useMemo(() => new Map(data ?? []), [data])
}
