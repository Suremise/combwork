// The GitHub host settings' titles and what they are (HI-2779): the window's GitHub group and the Assistant's settings tool.
import { msg } from './i18n/msg'

export const GITHUB_HOST_TEXT = {
  host: msg({ id: 'settings.github.host.title', defaultMessage: 'GitHub host', description: 'A setting (HI-2779): the host of the repositories: github.com, a GHE.com host (yourcompany.ghe.com) or a GitHub Enterprise Server.' }),
  hostDesc: msg({ id: 'settings.github.host.desc', defaultMessage: 'github.com, your GHE.com host (yourcompany.ghe.com) or your GitHub Enterprise Server’s name. Only the name: no path, port or token.', description: 'What the setting “GitHub host” takes (HI-2779). GHE.com is GitHub’s product name; keep the host names.' }),
  copilot: msg({ id: 'settings.github.copilotHost.title', defaultMessage: 'Copilot signs in on', description: 'A setting (HI-2779): the GitHub host GitHub Copilot signs in on, which can differ from the repositories’ host.' }),
  copilotDesc: msg({ id: 'settings.github.copilotHost.desc', defaultMessage: 'Usually the same as the GitHub host. With repositories on GitHub Enterprise Server, choose where your Copilot licence is: github.com or your GHE.com host.', description: 'What the setting “Copilot signs in on” is for (HI-2779). GHE.com is GitHub’s product name.' })
}
