import { execFile } from 'child_process'
import { join } from 'path'

/**
 * The processes that have a file open (HI-1749), as Windows' Restart Manager lists them (RmGetList): what held project.json
 * when its save failed with EPERM, which combwork.log couldn't say. Through PowerShell (a C# helper compiled for the call, a
 * second or two), so only after a write has failed; read-only (it registers the file and lists, never ends anything).
 * Each as "<pid> <application name>"; empty when none or it couldn't tell (another OS, PowerShell refused, a timeout).
 */

const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const SCRIPT = `
$src = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class CombworkFileHolders {
  [StructLayout(LayoutKind.Sequential)] struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType; public uint AppStatus; public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint h, int flags, string key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint nFiles, string[] files, uint nApps, IntPtr apps, uint nServices, string[] services);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint needed, ref uint n, [In, Out] RM_PROCESS_INFO[] info, ref uint reasons);
  public static string[] Of(string path) {
    var found = new List<string>();
    uint h;
    if (RmStartSession(out h, 0, Guid.NewGuid().ToString()) != 0) return found.ToArray();
    try {
      if (RmRegisterResources(h, 1, new string[] { path }, 0, IntPtr.Zero, 0, null) != 0) return found.ToArray();
      uint needed = 0, n = 0, reasons = 0;
      if (RmGetList(h, out needed, ref n, null, ref reasons) != 234 || needed == 0) return found.ToArray();
      var info = new RM_PROCESS_INFO[needed];
      n = needed;
      if (RmGetList(h, out needed, ref n, info, ref reasons) == 0) for (int i = 0; i < n; i++) found.Add(info[i].Process.dwProcessId + " " + info[i].strAppName);
    } finally { RmEndSession(h); }
    return found.ToArray();
  }
}
"@
Add-Type -TypeDefinition $src
[CombworkFileHolders]::Of($env:CW_HOLDER_PATH)
`

export function fileHolders(path: string): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([])
  return new Promise((res) => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { windowsHide: true, encoding: 'utf8', timeout: 20_000, env: { ...process.env, CW_HOLDER_PATH: path } }, (err, out) =>
      res(err ? [] : String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
    )
  })
}
