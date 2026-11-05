// First, before React DOM loads: a test copy's watch on React's commits (HI-1387).
import './commitWatch'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@vscode/codicons/dist/codicon.css'
import './styles/app.css'
import { App } from './App'
import { ConsoleApp } from './ConsoleApp'
import { ErrorBoundary } from './components/ErrorBoundary'
import { initLanguage } from './i18n'
import './commitLoop'
import { startWindowHealth } from './windowHealth'
import { initTeamPause } from './teamPause'
import { upgradeActivityViews } from './activityView'

// The same page is the developer console's window when opened with #console (#637).
const isConsole = location.hash === '#console'

// The language first, so the first render is in it (#767).
await initLanguage()
initTeamPause()
// The Activity tabs' views kept before 1.1, under their new keys before any is read (HI-2610).
upgradeActivityViews()

// The window's long tasks and where it is, for combwork.log (HI-1775): not the developer console's.
if (!isConsole) startWindowHealth()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary view={isConsole ? 'devConsole' : 'combwork'} root>
      {isConsole ? <ConsoleApp /> : <App />}
    </ErrorBoundary>
  </StrictMode>
)
