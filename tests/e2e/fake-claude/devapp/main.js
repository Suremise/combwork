// A dev copy of an Electron app (fake-claude's "devapp", #614): a hidden window, as an agent's dev launch of Combwork or a
// suite's Playwright copy is, its pid recorded once the window is made (FAKE_DEVAPP_FILE). Its profile is kept beside it,
// never in the user's AppData; it quits by itself after two minutes, in case a test leaves it.
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

app.setPath('userData', path.join(__dirname, 'profile'))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  await win.loadURL('data:text/html,<title>Dev copy</title>')
  fs.appendFileSync(process.env.FAKE_DEVAPP_FILE, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n')
})
app.on('window-all-closed', () => undefined)
setTimeout(() => app.quit(), 120000)
