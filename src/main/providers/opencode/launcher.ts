import { execFile } from 'child_process'
import { join } from 'path'
import { POWERSHELL } from '../../launchGate'

// The launcher an OpenCode agent's terminal runs (HI-2759, design s7 to s16): it owns the agent's private `opencode
// serve` and ends it with the agent, whatever ends first, without depending on Combwork's process tracking or its own
// JavaScript running.
//
// A hidden PowerShell runs CwOpencode.Run (C#, below). It:
// 1. opens a handle to the Combwork instance that launched it, checked by pid and exact creation time (GetProcessTimes,
//    obtained once by main: ownerToken), never by name;
// 2. makes a job object that ends its processes when its last handle closes (KILL_ON_JOB_CLOSE), holding the only handle,
//    and puts itself in it, so `serve`, the TUI and everything they start are in it from birth;
// 3. starts `opencode serve --hostname 127.0.0.1 --port <free>` hidden (OPENCODE_PASSWORD in its environment), its output to
//    a bounded log, and waits for GET /api/info to answer 200 (bounded; a port taken: up to 3 tries);
// 4. new: GET /api/session/<id>, 404 → POST {id, location}; 200 is an id clash and fails. resume: GET only; 200 must be that
//    id in one of the allowed folders; 404 fails ("session missing"), never creating one;
// 5. writes the server's address, port, pid and session id (never the password) for Combwork (opencode-server.json);
// 6. runs the TUI on the terminal's console: `opencode --server <url> --session <id> [flags] <folder>`;
// 7. waits for the owner, the TUI and serve: when any ends, it exits, and the job's handle closing ends the rest.
// A forced kill of the launcher closes the handle too. The messages it prints are English (a terminal's, CLI-facing).

/** The launcher's exit codes, beside the TUI's own (which it passes on): what went wrong before the TUI ran. */
export const LAUNCHER_EXIT = {
  owner: 120,
  job: 121,
  serverStart: 122,
  auth: 123,
  sessionCreate: 124,
  sessionClash: 125,
  sessionMismatch: 126,
  sessionMissing: 127,
  infoWrite: 128,
  serverEnded: 129,
  ownerEnded: 130,
  tuiStart: 131,
  input: 132
} as const

/** The C# the launcher compiles (Add-Type, .NET Framework 4's csc: C# 5, no newer syntax). */
export const LAUNCHER_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class CwOpencode {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, IntPtr name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref ExtendedLimits info, int len);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long a, b; public uint flags; public UIntPtr min, max; public uint active; public UIntPtr affinity; public uint priority, sched; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits basic; public Io io; public UIntPtr p, j, pu, ju; }

  static IntPtr job = IntPtr.Zero;
  static string E(string n) { return Environment.GetEnvironmentVariable(n) ?? ""; }
  static void Say(string s) { try { Console.Error.WriteLine("Combwork: " + s); } catch (Exception) { } }

  /** The owner: its handle, once its creation time is exactly the one Combwork gave. Null: not that process. */
  static WaitHandle HoldOwner(string token, out string why) {
    why = null;
    string[] p = token.Split(':');
    int pid; long created;
    if (p.Length != 2 || !int.TryParse(p[0], out pid) || !long.TryParse(p[1], out created) || pid <= 0 || created <= 0) { why = "its owner's identity is malformed"; return null; }
    IntPtr h = OpenProcess(0x00100000 | 0x1000, false, pid);
    if (h == IntPtr.Zero) { why = "Combwork's process (" + pid + ") can't be opened"; return null; }
    long c, x, k, u;
    if (!GetProcessTimes(h, out c, out x, out k, out u) || c != created) { why = "process " + pid + " isn't the Combwork that launched it"; new SafeWaitHandle(h, true).Dispose(); return null; }
    var w = new ManualResetEvent(false);
    w.SafeWaitHandle = new SafeWaitHandle(h, true);
    return w;
  }

  /** A job that ends its processes when its only handle (this process's) closes, with this process in it. */
  static string OwnJob() {
    job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
    if (job == IntPtr.Zero) return "CreateJobObject failed (" + Marshal.GetLastWin32Error() + ")";
    var info = new ExtendedLimits();
    info.basic.flags = 0x2000;
    if (!SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(ExtendedLimits)))) return "SetInformationJobObject failed (" + Marshal.GetLastWin32Error() + ")";
    if (!AssignProcessToJobObject(job, GetCurrentProcess())) return "AssignProcessToJobObject failed (" + Marshal.GetLastWin32Error() + ")";
    return null;
  }

  /** One argument as Windows' command-line rules read it back. */
  static string Q(string a) {
    if (a.Length > 0 && a.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return a;
    var b = new StringBuilder("\"");
    int slashes = 0;
    foreach (char ch in a) {
      if (ch == '\\') { slashes++; continue; }
      if (ch == '"') { b.Append('\\', slashes * 2 + 1).Append('"'); slashes = 0; continue; }
      b.Append('\\', slashes).Append(ch); slashes = 0;
    }
    return b.Append('\\', slashes * 2).Append('"').ToString();
  }
  static string Line(List<string> args) { var parts = new List<string>(); foreach (var a in args) parts.Add(Q(a)); return string.Join(" ", parts.ToArray()); }

  /** The executable started with these arguments: a .cmd or .bat through cmd.exe, as Combwork starts one (toSpawnable). */
  static ProcessStartInfo Start(string exe, List<string> args) {
    string ext = Path.GetExtension(exe).ToLowerInvariant();
    ProcessStartInfo s;
    if (ext == ".cmd" || ext == ".bat") {
      var all = new List<string>(); all.Add(exe); all.AddRange(args);
      s = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe"), "/d /s /c \"" + Line(all) + "\"");
    } else s = new ProcessStartInfo(exe, Line(args));
    s.UseShellExecute = false;
    return s;
  }

  static int FreePort() { var l = new TcpListener(IPAddress.Loopback, 0); l.Start(); int p = ((IPEndPoint)l.LocalEndpoint).Port; l.Stop(); return p; }

  /** An HTTP request to the server: its status (0: no answer) and body. */
  static int Http(string method, string url, string auth, string body, out string text) {
    text = "";
    try {
      var r = (HttpWebRequest)WebRequest.Create(url);
      r.Method = method; r.Timeout = 5000; r.ReadWriteTimeout = 5000; r.Proxy = null;
      r.Headers["Authorization"] = auth;
      if (body != null) {
        byte[] data = Encoding.UTF8.GetBytes(body);
        r.ContentType = "application/json"; r.ContentLength = data.Length;
        using (var s = r.GetRequestStream()) s.Write(data, 0, data.Length);
      }
      using (var resp = (HttpWebResponse)r.GetResponse()) { using (var rd = new StreamReader(resp.GetResponseStream(), Encoding.UTF8)) text = rd.ReadToEnd(); return (int)resp.StatusCode; }
    } catch (WebException e) {
      var resp = e.Response as HttpWebResponse;
      if (resp == null) return 0;
      try { using (var rd = new StreamReader(resp.GetResponseStream(), Encoding.UTF8)) text = rd.ReadToEnd(); } catch (Exception) { }
      return (int)resp.StatusCode;
    } catch (Exception) { return 0; }
  }

  /** A JSON string's characters escaped. */
  static string J(string s) {
    var b = new StringBuilder("\"");
    foreach (char c in s) { if (c == '"' || c == '\\') b.Append('\\').Append(c); else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4")); else b.Append(c); }
    return b.Append('"').ToString();
  }

  /** A string field of a JSON object's "data" (the session's id, its location's directory), from 2.2.6's replies. */
  static string Field(string json, string name) {
    int i = json.IndexOf("\"" + name + "\"", StringComparison.Ordinal);
    if (i < 0) return null;
    i = json.IndexOf(':', i); if (i < 0) return null;
    i = json.IndexOf('"', i); if (i < 0) return null;
    var b = new StringBuilder();
    for (int k = i + 1; k < json.Length; k++) {
      char c = json[k];
      if (c == '\\' && k + 1 < json.Length) { char n = json[++k]; if (n == 'u' && k + 4 < json.Length) { b.Append((char)Convert.ToInt32(json.Substring(k + 1, 4), 16)); k += 4; } else b.Append(n == 'n' ? '\n' : n == 't' ? '\t' : n == 'r' ? '\r' : n); continue; }
      if (c == '"') return b.ToString();
      b.Append(c);
    }
    return null;
  }

  static string Norm(string p) { try { p = Path.GetFullPath(p); } catch (Exception) { } return p.TrimEnd('\\', '/').ToLowerInvariant(); }

  /** serve's output to the log, at most max bytes (then one line saying so). */
  static void Pump(Stream from, Stream to, long max, object gate) {
    var buf = new byte[8192]; int n;
    try {
      while ((n = from.Read(buf, 0, buf.Length)) > 0) {
        lock (gate) {
          if (to.Length >= max) continue;
          to.Write(buf, 0, (int)Math.Min(n, max - to.Length)); to.Flush();
          if (to.Length >= max) { byte[] m = Encoding.UTF8.GetBytes("\n[Combwork: log capped]\n"); to.Write(m, 0, m.Length); to.Flush(); }
        }
      }
    } catch (Exception) { }
  }

  public static int Run() {
    string exe = E("CW_OC_EXE"), cwd = E("CW_OC_CWD"), session = E("CW_OC_SESSION"), intent = E("CW_OC_INTENT"), info = E("CW_OC_INFO"), log = E("CW_OC_LOG"), owner = E("CW_OC_OWNER"), marks = E("CW_OC_MARKS");
    string pw = E("OPENCODE_PASSWORD");
    int readyMs; if (!int.TryParse(E("CW_OC_READY_MS"), out readyMs) || readyMs < 1000) readyMs = 30000;
    long logMax; if (!long.TryParse(E("CW_OC_LOG_MAX"), out logMax) || logMax < 4096) logMax = 1048576;
    var tuiArgs = new List<string>(); foreach (string a in E("CW_OC_TUI_ARGS").Split('\u001f')) if (a.Length > 0) tuiArgs.Add(a);
    var dirs = new List<string>(); foreach (string d in E("CW_OC_DIRS").Split('\u001f')) if (d.Length > 0) dirs.Add(Norm(d));
    foreach (string n in new string[] { "CW_OC_MARKS", "CW_OC_EXE", "CW_OC_CWD", "CW_OC_SESSION", "CW_OC_INTENT", "CW_OC_INFO", "CW_OC_LOG", "CW_OC_OWNER", "CW_OC_READY_MS", "CW_OC_LOG_MAX", "CW_OC_TUI_ARGS", "CW_OC_DIRS", "CW_OC_CS" }) Environment.SetEnvironmentVariable(n, null);
    if (exe == "" || cwd == "" || pw == "" || info == "" || log == "" || marks == "" || !session.StartsWith("ses") || (intent != "new" && intent != "resume")) { Say("the launch was given incomplete settings."); return ${LAUNCHER_EXIT.input}; }

    string why;
    WaitHandle ownerWait = null;
    if (owner != "") { ownerWait = HoldOwner(owner, out why); if (ownerWait == null) { Say("OpenCode didn't start: " + why + "."); return ${LAUNCHER_EXIT.owner}; } }
    why = OwnJob();
    if (why != null) { Say("OpenCode didn't start: its server couldn't be given a lifetime of its own (" + why + ")."); return ${LAUNCHER_EXIT.job}; }

    string auth = "Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes("opencode:" + pw));
    Process serve = null; string url = null; int port = 0;
    var gate = new object();
    FileStream logFile;
    try { logFile = new FileStream(log, FileMode.Append, FileAccess.Write, FileShare.ReadWrite); } catch (Exception e) { Say("OpenCode didn't start: its server's log couldn't be opened (" + e.Message + ")."); return ${LAUNCHER_EXIT.serverStart}; }
    for (int attempt = 0; attempt < 3 && url == null; attempt++) {
      port = FreePort();
      var s = Start(exe, new List<string> { "serve", "--hostname", "127.0.0.1", "--port", port.ToString() });
      s.CreateNoWindow = true; s.RedirectStandardOutput = true; s.RedirectStandardError = true; s.RedirectStandardInput = true; s.WorkingDirectory = cwd;
      try { serve = Process.Start(s); } catch (Exception e) { Say("OpenCode didn't start: its server couldn't be run (" + e.Message + ")."); return ${LAUNCHER_EXIT.serverStart}; }
      var p = serve;
      new Thread(() => Pump(p.StandardOutput.BaseStream, logFile, logMax, gate)) { IsBackground = true }.Start();
      new Thread(() => Pump(p.StandardError.BaseStream, logFile, logMax, gate)) { IsBackground = true }.Start();
      var until = DateTime.UtcNow.AddMilliseconds(readyMs);
      while (DateTime.UtcNow < until) {
        string body;
        int st = Http("GET", "http://127.0.0.1:" + port + "/api/info", auth, null, out body);
        if (st == 200) { url = "http://127.0.0.1:" + port; break; }
        if (st == 401) { Say("OpenCode's server refused Combwork's password."); return ${LAUNCHER_EXIT.auth}; }
        if (serve.WaitForExit(200)) break;
      }
      if (url == null && !serve.HasExited) { Say("OpenCode's server didn't answer within " + (readyMs / 1000) + " s."); return ${LAUNCHER_EXIT.serverStart}; }
    }
    if (url == null) { Say("OpenCode's server ended as it started (see " + log + ")."); return ${LAUNCHER_EXIT.serverStart}; }

    string reply;
    int got = Http("GET", url + "/api/session/" + Uri.EscapeDataString(session), auth, null, out reply);
    if (intent == "new") {
      if (got == 200) { Say("a session " + session + " already exists: Combwork doesn't take another's session."); return ${LAUNCHER_EXIT.sessionClash}; }
      if (got != 404) { Say("OpenCode's server couldn't be asked for the session (HTTP " + got + ")."); return ${LAUNCHER_EXIT.sessionCreate}; }
      int made = Http("POST", url + "/api/session", auth, "{\"id\":" + J(session) + ",\"location\":{\"directory\":" + J(cwd) + "}}", out reply);
      if (made != 200 || Field(reply, "id") != session) { Say("OpenCode didn't create the session (HTTP " + made + ")."); return ${LAUNCHER_EXIT.sessionCreate}; }
      // Combwork's record that this account's data holds the session (its resume looks for it here: sessionMark).
      try { Directory.CreateDirectory(marks); File.WriteAllText(Path.Combine(marks, session + ".json"), "{\"id\":" + J(session) + ",\"directory\":" + J(cwd) + "}"); } catch (Exception e) { Say("Combwork couldn't record the session (" + e.Message + ")."); return ${LAUNCHER_EXIT.infoWrite}; }
    } else {
      if (got == 404) { Say("OpenCode no longer has session " + session + " in this account's data."); return ${LAUNCHER_EXIT.sessionMissing}; }
      if (got != 200) { Say("OpenCode's server couldn't be asked for the session (HTTP " + got + ")."); return ${LAUNCHER_EXIT.sessionMismatch}; }
      string dir = Field(reply, "directory");
      if (Field(reply, "id") != session || dir == null || !dirs.Contains(Norm(dir))) { Say("session " + session + " belongs to another folder: not resumed."); return ${LAUNCHER_EXIT.sessionMismatch}; }
    }
    try {
      string tmp = info + ".tmp";
      File.WriteAllText(tmp, "{\"url\":" + J(url) + ",\"port\":" + port + ",\"serverPid\":" + serve.Id + ",\"sessionId\":" + J(session) + ",\"pid\":" + Process.GetCurrentProcess().Id + "}");
      if (File.Exists(info)) File.Delete(info);
      File.Move(tmp, info);
    } catch (Exception e) { Say("Combwork couldn't record OpenCode's server (" + e.Message + ")."); return ${LAUNCHER_EXIT.infoWrite}; }

    var t = new List<string> { "--server", url, "--session", session };
    t.AddRange(tuiArgs);
    t.Add(cwd);
    var ts = Start(exe, t);
    ts.WorkingDirectory = cwd;
    Process tui;
    try { tui = Process.Start(ts); } catch (Exception e) { Say("OpenCode's interface couldn't be run (" + e.Message + ")."); return ${LAUNCHER_EXIT.tuiStart}; }
    var waits = new List<WaitHandle>();
    waits.Add(new ManualResetEvent(false) { SafeWaitHandle = new SafeWaitHandle(tui.Handle, false) });
    waits.Add(new ManualResetEvent(false) { SafeWaitHandle = new SafeWaitHandle(serve.Handle, false) });
    if (ownerWait != null) waits.Add(ownerWait);
    int which = WaitHandle.WaitAny(waits.ToArray());
    if (which == 0) { tui.WaitForExit(); return tui.ExitCode; }
    if (which == 1) { Say("OpenCode's server ended (see " + log + ")."); return ${LAUNCHER_EXIT.serverEnded}; }
    return ${LAUNCHER_EXIT.ownerEnded};
  }
}
`

/**
 * The PowerShell the terminal runs: compiles the launcher (its source in the launch's private folder: CW_OC_CS) and runs
 * it. No cmdlet but Add-Type. A failure to compile ends it with a message (the terminal's, English).
 */
const BOOTSTRAP = `
try { Add-Type -TypeDefinition ([System.IO.File]::ReadAllText($env:CW_OC_CS)) -ErrorAction Stop } catch { [Console]::Error.WriteLine("Combwork: OpenCode didn't start: its launcher couldn't be compiled ($($_.Exception.Message))."); exit ${LAUNCHER_EXIT.job} }
exit [CwOpencode]::Run()
`

export const LAUNCHER_ARGS = ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(BOOTSTRAP, 'utf16le').toString('base64')] // i18n-ignore: a command line's arguments

/** What the launcher is told (its environment: nothing on its command line is quoted twice). */
export interface LauncherInput {
  executable: string
  cwd: string
  sessionId: string
  intent: 'new' | 'resume'
  /** The TUI's flags beyond --server, --session and the folder (a mode's, the agent's extra arguments). */
  tuiArgs: string[]
  /** Folders a resumed session may belong to (the launch's, the agent's project's). */
  dirs: string[]
  /** The launch's private folder: the launcher's source, the server's log and its record go there. */
  privateDir: string
  /** "pid:creation" of the Combwork instance launching it (ownerToken); empty: none (a test). */
  owner: string
  /** The account's folder of Combwork's session records (sessionMarks). */
  marks: string
  readyMs: number
}

/** Where Combwork records the sessions it created in an account's data (the launcher writes one as it creates it). */
export const sessionMarks = (home: string): string => join(home, 'combwork-sessions')
export const sessionMark = (home: string, sessionId: string): string => join(sessionMarks(home), `${sessionId}.json`)

/** Where the launcher records the server (opencode-server.json) and its log, in the launch's private folder. */
export const serverInfoPath = (privateDir: string): string => join(privateDir, 'opencode-server.json')
export const serverLogPath = (privateDir: string): string => join(privateDir, 'opencode-serve.log')
export const launcherSourcePath = (privateDir: string): string => join(privateDir, 'cw-opencode.cs')

/** The launcher's variables (the source file is written by prepareLaunch: launcherSourcePath). */
export function launcherEnv(i: LauncherInput): Record<string, string> {
  return {
    CW_OC_EXE: i.executable,
    CW_OC_CWD: i.cwd,
    CW_OC_SESSION: i.sessionId,
    CW_OC_INTENT: i.intent,
    CW_OC_TUI_ARGS: i.tuiArgs.join('\u001f'),
    CW_OC_DIRS: i.dirs.join('\u001f'),
    CW_OC_INFO: serverInfoPath(i.privateDir),
    CW_OC_LOG: serverLogPath(i.privateDir),
    CW_OC_CS: launcherSourcePath(i.privateDir),
    CW_OC_OWNER: i.owner,
    CW_OC_MARKS: i.marks,
    CW_OC_READY_MS: String(i.readyMs)
  }
}

/** A Windows FILETIME's text as GetProcessTimes gives it: a whole number of 100 ns since 1601. */
const isFiletime = (s: string): boolean => /^\d{15,19}$/.test(s)

// i18n-ignore: a script's source, never shown
const OWNER_SCRIPT = `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CwOwner { [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint a, bool i, int p); [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h); [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h, out long c, out long e, out long k, out long u); public static long Of(int pid) { IntPtr h = OpenProcess(0x1000, false, pid); if (h == IntPtr.Zero) return 0; try { long c, e, k, u; return GetProcessTimes(h, out c, out e, out k, out u) ? c : 0; } finally { CloseHandle(h); } } }'
[Console]::Out.Write([CwOwner]::Of([int]$env:CW_OWNER_PID))
`

/**
 * A process's identity as its launchers check it: "pid:creation", the creation time exactly as Windows' GetProcessTimes
 * gives it (read by a hidden PowerShell, off main's thread). Empty when it can't be read.
 */
export function processToken(pid: number): Promise<string> {
  if (process.platform !== 'win32') return Promise.resolve('')
  return new Promise((done) => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(OWNER_SCRIPT, 'utf16le').toString('base64')], { timeout: 60_000, windowsHide: true, env: { ...process.env, CW_OWNER_PID: String(pid) } }, (e, out) => {
      const v = String(out ?? '').trim()
      done(!e && isFiletime(v) && v !== '0' ? `${pid}:${v}` : '')
    })
  })
}

let owner: Promise<string> | null = null

/** This Combwork's identity for its launchers (processToken), read once. Empty when it can't be read: OpenCode launches then refuse. */
export function ownerToken(): Promise<string> {
  owner ??= processToken(process.pid).then((v) => {
    if (!v) owner = null
    return v
  })
  return owner
}
