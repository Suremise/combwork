import type { TemplateEntry } from '@shared/templates'
import { msg, tr } from '@shared/i18n'
import { call, errorMessage } from './api'
import { findProject, get, notify } from './store'

/** The templates a project can use (Hive's own, the workspace's and its own), or null after saying why they couldn't be listed. */
export const templateList = (path: string): Promise<TemplateEntry[] | null> =>
  call('templates:list', path).catch((e) => {
    notify('error', tr(msg({ id: 'panes.template.listFailed', defaultMessage: 'Could not list the templates', description: "An error's title: Combwork couldn't read the templates (+ Add ▾ → Templates, Add Agent from Template)." })), errorMessage(e))
    return null
  })

/**
 * The templates a project can use, for a menu opened on it (HI-1948), its agents named for the project by main
 * (`agentNames`), or null: when they can't be listed (said), or by the time the list came the window had left the
 * workspace it was asked in, or no longer has the project.
 */
export async function templatesStillHere(path: string): Promise<TemplateEntry[] | null> {
  const ws = get().workspace?.path
  const all = await templateList(path)
  return all && ws && get().workspace?.path === ws && findProject(get(), path) ? all : null
}
