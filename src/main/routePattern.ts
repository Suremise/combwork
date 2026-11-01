/**
 * The Agent API's route templates as patterns (`/v1/tasks/:n` matches `/v1/tasks/12`): each `:param` one path segment.
 * `:agent` may be empty (HI-2258): `/v1/projects/alpha/agents//activity` is the call that names no agent, which the
 * routes answer as the project's sole agent, or refuse saying which is missing (servers.ts `agentParam`), as the hive
 * tools' optional `agent` says. Every other parameter needs a segment, so an empty one still finds no route.
 */
export function routePattern(template: string): RegExp {
  return new RegExp('^' + template.replace(/:([a-zA-Z]+)/g, (_, name: string) => (name === 'agent' ? '([^/]*)' : '([^/]+)')) + '/?$')
}
