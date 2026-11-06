// The Combwork Assistant's attachments (#243, #387): listed from its home (a session host, not a project), grouped by
// conversation; deleting one, or a conversation's group, has the checks of deleting sessions (#239): none while the conversation
// runs, and none if another program has one open (all or nothing).
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-aattach-')
process.env.CLAUDE_CONFIG_DIR = join(base, 'claude-home')
process.env.CODEX_HOME = join(base, 'codex-home')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
// The Recycle Bin, as deleting the file; `duringTrash` runs at the first one (something happening meanwhile).
const trashed: string[] = []
let duringTrash: (() => Promise<void>) | null = null
;(electron.shell as unknown as { trashItem: (p: string) => Promise<void> }).trashItem = async (p) => {
  const fn = duringTrash
  duringTrash = null
  await fn?.()
  rmSync(p, { force: true })
  trashed.push(p)
}

const { createWorkspaceService, disposeWorkspaceService, inWorkspace, workspace } = await import('../src/main/workspace')
const files = await import('../src/main/files')
const { forgetMoves } = await import('../src/main/attachmentsFolder')
const { sessions } = await import('../src/main/sessions')

const wsPath = join(base, 'ws')
const home = join(wsPath, '.combwork', 'assistant')
const s = sessions as unknown as { live: Map<string, unknown> }
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
const conv = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'
const attachmentsOf = (id: string): string => join(home, '.combwork', 'attachments', id)
const png = (id: string, name: string): string => {
  const p = join(attachmentsOf(id), name)
  mkdirSync(attachmentsOf(id), { recursive: true })
  writeFileSync(p, 'png')
  return p
}

const holders: ChildProcess[] = []
async function hold(file: string): Promise<void> {
  const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = `$f = [IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'None'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Seconds 60`
  const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  holders.push(child)
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('the file was not held in time')), 20000)
    child.stdout!.on('data', (d) => String(d).includes('held') && (clearTimeout(t), resolve()))
    child.on('exit', () => reject(new Error('the holder exited')))
  })
}

describe.runIf(process.platform === 'win32')("the Assistant's attachments", () => {
  beforeAll(async () => {
    mkdirSync(join(wsPath, 'api'), { recursive: true })
    w = createWorkspaceService()
    await w.open(wsPath)
    await run(() => workspace.upsertSession(home, { id: conv, agent: 'claude-code', name: 'Planning the week' }))
  })
  // Each case starts with no attachments of the Assistant's: what one leaves (a group kept, a junction) is never another's.
  beforeEach(() => {
    forgetMoves()
    for (const root of [join(home, '.combwork', 'attachments'), join(home, '.combwork', 'images')]) {
      for (const name of existsSync(root) ? readdirSync(root) : []) {
        const p = join(root, name)
        // A junction (the link case's) goes as a link, never followed into the folder it points at.
        if (lstatSync(p).isSymbolicLink()) rmdirSync(p)
        else rmSync(p, { recursive: true, force: true })
      }
    }
  })
  afterEach(() => {
    s.live.clear()
    for (const h of holders.splice(0)) h.kill()
    trashed.length = 0
  })
  afterAll(async () => {
    await disposeWorkspaceService(w)
    // Clearing a junction between cases left the user's folder it pointed at as it was.
    if (existsSync(join(base, 'outside'))) expect(readFileSync(join(base, 'outside', 'personal.png'), 'utf8')).toBe('mine')
  })

  it('lists them from its home, by conversation, with its name', async () => {
    png(conv, '2026-10-05T10-00-00.png')
    png(conv, '2026-10-05T11-00-00.png')
    const groups = await run(() => files.listAttachments(home))
    expect(groups.map((g) => [g.sessionId, g.name, g.attachments.length])).toEqual([[conv, 'Planning the week', 2]])
    expect(groups[0].attachments[0].name).toBe('2026-10-05T11-00-00.png')
  })

  it('one attachment held by another program is not deleted; a conversation group goes all or none', async () => {
    // Another conversation's attachments, which stay.
    const kept = '00000000-0000-4000-8000-000000000005'
    png(kept, '2026-10-05T08-30-00.png')
    const a = png(other, '2026-10-05T09-00-00.png')
    const b = png(other, '2026-10-05T09-30-00.png')
    await hold(b)
    await expect(run(() => files.trashAttachment(home, b))).rejects.toThrow(/Another program has this file open/)
    await expect(run(() => files.trashAttachmentGroup(home, other))).rejects.toThrow(/one of these files open/)
    expect(existsSync(a) && existsSync(b)).toBe(true)
    expect(trashed).toEqual([])
    // Let go once each holder has exited (Windows closes a process's handles as it ends).
    await Promise.all(holders.splice(0).map((h) => new Promise<void>((done) => (h.exitCode !== null || h.signalCode !== null ? done() : (h.once('exit', () => done()), h.kill())))))
    expect(await run(() => files.trashAttachmentGroup(home, other))).toBe(2)
    expect(existsSync(attachmentsOf(other))).toBe(false)
    expect(readdirSync(attachmentsOf(kept))).toEqual(['2026-10-05T08-30-00.png'])
  })

  it('not while the conversation runs: neither one attachment nor its group', async () => {
    png(conv, '2026-10-05T10-00-00.png')
    png(conv, '2026-10-05T11-00-00.png')
    s.live.set('assistant', { state: { provider: 'claude-code', runId: 'r', projectPath: home, agentId: 'assistant', sessionId: conv, status: 'ready' } })
    await expect(run(() => files.trashAttachmentGroup(home, conv))).rejects.toThrow(/running/)
    const one = join(attachmentsOf(conv), readdirSync(attachmentsOf(conv))[0])
    await expect(run(() => files.trashAttachment(home, one))).rejects.toThrow(/running/)
    expect(readdirSync(attachmentsOf(conv)).length).toBe(2)
  })

  it("the conversation can't resume while its attachments go (it would paste more)", async () => {
    const id = '00000000-0000-4000-8000-000000000003'
    png(id, '2026-10-05T08-00-00.png')
    png(id, '2026-10-05T08-10-00.png')
    let refused: unknown = null
    duringTrash = async () => {
      refused = await run(() => sessions.start(home, { resumeId: id, agentId: 'assistant' })).catch((e) => e)
    }
    expect(await run(() => files.trashAttachmentGroup(home, id))).toBe(2)
    expect(String(refused)).toMatch(/archiving, deleting or cleaning up this session's files/)
    expect(s.live.size).toBe(0)
  })

  it('never deletes through a link out of the attachments folder: a linked group, or a linked attachments folder', async () => {
    // A group folder that is a junction to a folder of the user's.
    const outside = join(base, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'personal.png'), 'mine')
    const linked = '00000000-0000-4000-8000-000000000004'
    mkdirSync(join(home, '.combwork', 'attachments'), { recursive: true })
    symlinkSync(outside, attachmentsOf(linked), 'junction')
    await expect(run(() => files.trashAttachmentGroup(home, linked))).rejects.toThrow(/Not one of the session attachments/)
    await expect(run(() => files.trashAttachment(home, join(attachmentsOf(linked), 'personal.png')))).rejects.toThrow(/Not one of the session attachments/)
    expect((await run(() => files.listAttachments(home))).some((g) => g.sessionId === linked)).toBe(false)
    expect(readFileSync(join(outside, 'personal.png'), 'utf8')).toBe('mine')
    expect(trashed).toEqual([])
    // A project whose whole .combwork/attachments is a junction elsewhere: not listed, nothing deleted; nor is an old
    // .combwork/images that is one moved into it.
    const api = join(wsPath, 'api')
    mkdirSync(join(api, '.combwork'), { recursive: true })
    const outsideRoot = join(base, 'outside-root')
    mkdirSync(join(outsideRoot, linked), { recursive: true })
    writeFileSync(join(outsideRoot, linked, 'personal.png'), 'mine too')
    symlinkSync(outsideRoot, join(api, '.combwork', 'attachments'), 'junction')
    symlinkSync(outsideRoot, join(api, '.combwork', 'images'), 'junction')
    expect(await run(() => files.listAttachments(api))).toEqual([])
    await expect(run(() => files.trashAttachmentGroup(api, linked))).rejects.toThrow(/Not one of the session attachments/)
    await expect(run(() => files.trashAttachment(api, join(api, '.combwork', 'attachments', linked, 'personal.png')))).rejects.toThrow(/Not a session attachment/)
    expect(readFileSync(join(outsideRoot, linked, 'personal.png'), 'utf8')).toBe('mine too')
  })

  it('refuses ids and paths that are not its attachments', async () => {
    await expect(run(() => files.trashAttachmentGroup(home, '../x'))).rejects.toThrow()
    await expect(run(() => files.trashAttachment(home, join(home, '.combwork', 'sessions.json')))).rejects.toThrow(/Not a session attachment/)
    await expect(run(() => files.listAttachments(join(base, 'elsewhere')))).rejects.toThrow()
  })
})
