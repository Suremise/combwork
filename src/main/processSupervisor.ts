import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Writable } from 'stream'

/**
 * Hive's process supervisor (#507, #543, #659, #678; shared since #1360): one hidden PowerShell per Hive (its C#
 * through Add-Type) holding Windows job objects, that both agents' launches (agentProcesses.ts) and the merge queue's
 * runners (workflow/queueRunner.ts) use, never a copy of it each.
 *
 * Each job owns the processes put in it and everything they start from then on; what escapes it (a packaged app's
 * process, such as the Store's PowerShell, starts its children outside every job) is adopted into it, or followed with
 * its handle held, by the sweeps. An agent's launch's job is unnamed and ends nothing when it closes (quitting Combwork
 * leaves running what the user chose to keep). A merge queue lease's job is named after its lease and kill on close
 * (no process of a queue outlives its job), and each process it follows is told ("followed <job> <pid>:<created>"),
 * for its runner to keep as a duty (a followed process isn't in the job, so closing it doesn't end one).
 */

/** At most this many processes a job lists (the rest are counted, and ended with it). */
export const MAX_LISTED = 50
/** How often the host adopts what escaped its jobs (Sweep, #543), while it holds any; listing and ending sweep first. */
const SWEEP_MS = 1000
/** How long the host gathers the exits of a job's processes before sweeping for what they left outside (Listen). */
const EXIT_BATCH_MS = 250

const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** Why the host couldn't start (its owner says it in its own words). */
export type HostFailure = { kind: 'test' } | { kind: 'noPowerShell'; error: string } | { kind: 'slowHelper'; seconds: number } | { kind: 'refused' } | { kind: 'helperFailed'; why: string }

/** The host's requests (CombworkJobs.Answer). */
export type HostCommand = 'add' | 'list' | 'kill' | 'forget' | 'identify' | 'endexact' | 'endtree' | 'memory' | 'lineage' | 'open' | 'assign' | 'empty' | 'endnamed' | 'hasjob' | 'follow' | 'keeper' | 'running' | 'paths' | 'workingin'

/** The most processes one `workingin` answer describes (HI-2467); more, and it says it isn't whole. */
export const MAX_WORKING_IN = 32

export interface JobHostOptions {
  /** How long it gets to start, and then to answer each request. */
  waitMs: () => number
  /** Test copies' modes (CW_TEST_PROCESS_TRACKER: fail, silent, mute); '' otherwise. */
  testMode: () => string
  log: { warn: (msg: string, e?: unknown) => void }
  /** A process joined a job, or was taken into one ("new"). */
  onJoined: () => void
  /** It ended unexpectedly, its jobs with it. */
  onLost: (why: string) => void
  /** It couldn't start: nothing is tracked. */
  onFailed: (why: HostFailure) => void
  /** Starts its helper instead (tests), as given (its launcher's PowerShell and arguments, helperLaunch; or a test mode's). */
  launch?: (file: string, args: string[]) => ChildProcessWithoutNullStreams
  /** Test requests allowed (`follow`): unpackaged builds and unit tests only. */
  testRequests?: boolean
}

// Raw: the C# keeps its backslashes. Exported for the unit tests, which drive it with stale process identities.
export const HOST_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
public static class CombworkJobs {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, IntPtr name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr proc, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, int len, IntPtr ret);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr proc, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, int pid);
  [DllImport("kernel32.dll")] static extern void GetSystemTimeAsFileTime(out long now);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern int GetPackageFullName(IntPtr proc, ref int len, StringBuilder name);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref ProcessEntry e);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref ProcessEntry e);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct ProcessEntry {
    public uint size, usage, pid; public IntPtr heap; public uint module, threads, parent; public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string exe;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr port, UIntPtr key, uint threads);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetQueuedCompletionStatus(IntPtr port, out uint message, out UIntPtr key, out IntPtr detail, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref PortInfo info, int len);
  [StructLayout(LayoutKind.Sequential)] struct PortInfo { public IntPtr key; public IntPtr port; }
  // The merge queue's jobs (#1360): named, kill on close.
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode, EntryPoint="CreateJobObjectW")] static extern IntPtr CreateNamedJob(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode, EntryPoint="OpenJobObjectW")] static extern IntPtr OpenNamedJob(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError=true, EntryPoint="SetInformationJobObject")] static extern bool SetLimits(IntPtr job, int cls, ref ExtLimits info, int len);
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long a, b; public uint flags; public UIntPtr minWs, maxWs; public uint active; public UIntPtr affinity; public uint prio, sched; }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct ExtLimits { public BasicLimits basic; public IoCounters io; public UIntPtr procMem, jobMem, peakProc, peakJob; }
  /**
   * The kill-on-close jobs (the merge queue's), by id, each with its journal: the file each process it follows is
   * written to, durably, before it is followed (Journal), so another Combwork can end it after a crash (#1360).
   */
  static Dictionary<string, string> closing = new Dictionary<string, string>();
  /** A kill-on-close job's processes it couldn't journal, and so ended at once, not told yet: "unowned <job> <pid>". */
  static List<string> queueNotes = new List<string>();
  /** The name of a merge queue lease's job, in this Windows session. */
  public static string QueueJobName(string id) { return "Local\\CombworkQueue-" + id; }
  static Dictionary<string, IntPtr> jobs = new Dictionary<string, IntPtr>();
  /** Processes each job adopted (Sweep), for the log. */
  static Dictionary<string, int> adopted = new Dictionary<string, int>();
  /** Requests (the main thread), the port's thread and the timer's take turns. */
  static readonly object turn = new object();
  static System.Threading.Timer sweeper;
  /** Every job reports to one port: a process joining it, and one ending (each job by its key). */
  static IntPtr port = IntPtr.Zero;
  static Dictionary<ulong, string> byKey = new Dictionary<ulong, string>();
  static ulong nextKey = 1;
  /**
   * Where a process joining a job (or taken into one) is told, as a line "new" (#1134: main writes its running marker
   * again); null tells nothing (the unit tests' own scripts). Told once per job until that job is listed again or its
   * launch starts (told), so a build starting hundreds of processes says it once per marker write. A notice due (tell)
   * is written outside the turn (Tell), and listing never takes one back: listing one job says nothing of another's
   * process that joined just before (round 1 of #1134).
   */
  public static System.IO.TextWriter Notices;
  static HashSet<string> told = new HashSet<string>();
  static bool tell = false;
  /** Public for the unit tests, which give joins and listings in an order of their own. Under the turn. */
  public static void Joined(string id) { if (told.Add(id)) tell = true; }
  /** What joins job id after this is told again: what joined before is in its listing. Under the turn. */
  static void Untold(string id) { told.Remove(id); }
  /** Writes the notice due, if any. Public for the unit tests. */
  public static void Tell() {
    bool t;
    lock (turn) { t = tell; tell = false; }
    var w = Notices;
    if (t && w != null) try { w.WriteLine("new"); w.Flush(); } catch { }
    TellQueue();
  }
  /** Writes the kill-on-close jobs' notices not told yet (agents' jobs have none). */
  public static void TellQueue() {
    List<string> notes;
    lock (turn) { if (queueNotes.Count == 0) return; notes = queueNotes; queueNotes = new List<string>(); }
    var w = Notices;
    if (w != null) try { foreach (var n in notes) w.WriteLine(n); w.Flush(); } catch { }
  }
  /**
   * Before a kill-on-close job follows a process: its identity ("pid:created:check") written to the job's journal and flushed
   * through to the disk, so it outlives a crash of this host or of Combwork. False when it couldn't be (no journal, a write
   * that failed): the caller ends the process at once instead (fail closed).
   */
  static bool Journal(string id, int pid, long created) {
    string path;
    if (!closing.TryGetValue(id, out path) || string.IsNullOrEmpty(path)) return false;
    try {
      using (var f = new System.IO.FileStream(path, System.IO.FileMode.Append, System.IO.FileAccess.Write, System.IO.FileShare.ReadWrite, 4096, System.IO.FileOptions.WriteThrough)) {
        // "pid:created:check", newline-terminated: check = (pid + created) mod 1000003, so a record cut short or damaged
        // (a torn append) is told from a whole one (queueJobs.ts journalOf).
        byte[] b = Encoding.ASCII.GetBytes(pid + ":" + created + ":" + ((pid + created) % 1000003) + "\n");
        f.Write(b, 0, b.Length);
        f.Flush(true);
      }
      return true;
    } catch { return false; }
  }
  /**
   * Follows a process for job id (Take, Follow): a kill-on-close job's is journalled first, and one it can't journal is
   * ended now (its handle can: PROCESS_TERMINATE) and told ("unowned"), never followed without a durable identity.
   * Whether it is followed.
   */
  static bool FollowHeld(string id, int pid, IntPtr h, long created) {
    if (closing.ContainsKey(id) && !Journal(id, pid, created)) {
      TerminateProcess(h, 1);
      queueNotes.Add("unowned " + id + " " + pid);
      return false;
    }
    followed[pid] = new Held { job = id, h = h, created = created };
    return true;
  }
  class Held { public string job; public IntPtr h; public long created; }
  /**
   * The jobs' processes, each held open from joining until it ends: while held, its id can't name another process, and
   * its start time can be read after it has exited, when its escaped children are adopted.
   */
  static Dictionary<int, Held> held = new Dictionary<int, Held>();
  /**
   * Escaped processes that aren't put in their parent's job, being in a job already (the Store's PowerShell is in its
   * package's, #659) or a packaged app's, which Windows puts in its package's job as it starts (#678): followed instead,
   * held open, listed and ended with the job, and their own escaped children taken in as they are found.
   */
  static Dictionary<int, Held> followed = new Dictionary<int, Held>();
  /**
   * Adopts what escaped the jobs (#543): a packaged app's process (the Microsoft Store's PowerShell 7) starts its
   * children outside every job, so they would neither be listed nor ended. Each live process whose parent is in a job
   * (running, or held as it ends), that is itself not in that job, joins it if it is in no job and isn't a packaged
   * app's (its own children join by themselves from then on), or is followed (Take); those it started before are found
   * in the same sweep. The parent must have started before the child: a parent id not held could name a later process
   * that took a dead parent's id.
   * Swept as each process of a job ends (so a shell that starts something and exits at once is caught), before listing
   * or ending a job, and every ${SWEEP_MS} ms (for an escaped child's own children).
   */
  /**
   * What sweeps couldn't be sure of (HI-2055): a snapshot or a job's listing that failed, or a process of a job's whose
   * escaped child it couldn't check (a call Windows refused, not one that says the child has gone or isn't one). The
   * keeper counts a job empty only after a sweep with none: an escaped child neither adopted nor followed would be missed.
   */
  public static int uncertain = 0;
  /** The unit tests: while this file exists, every sweep's snapshot fails, as Windows refusing one would, each noted in <file>.failed. */
  public static string FailSnapshotsWhile = null;
  static bool SnapshotFailsForTests() {
    if (FailSnapshotsWhile == null || !System.IO.File.Exists(FailSnapshotsWhile)) return false;
    try { System.IO.File.AppendAllText(FailSnapshotsWhile + ".failed", "x"); } catch { }
    return true;
  }
  /** The unit tests: while this file exists, every sweep's enumeration of its snapshot stops after its first entry, failing. */
  public static string FailEnumerationWhile = null;
  static bool EnumerationFailsForTests() {
    if (FailEnumerationWhile == null || !System.IO.File.Exists(FailEnumerationWhile)) return false;
    try { System.IO.File.AppendAllText(FailEnumerationWhile + ".failed", "x"); } catch { }
    return true;
  }
  public static int Sweep() {
    lock (turn) {
      if (jobs.Count == 0) return 0;
      var parents = new Dictionary<int, int>();
      // Taken before the snapshot: a process created after it can't be one the snapshot saw.
      long at; GetSystemTimeAsFileTime(out at);
      // TH32CS_SNAPPROCESS
      IntPtr snap = SnapshotFailsForTests() ? IntPtr.Zero : CreateToolhelp32Snapshot(2, 0);
      if (snap == IntPtr.Zero || snap == new IntPtr(-1)) { uncertain++; return 0; }
      // A snapshot read whole, or not used (HR2's round 2): an enumeration that fails, at its first entry or part way
      // (anything but ERROR_NO_MORE_FILES at its end), would miss the processes after it.
      try {
        var e = new ProcessEntry(); e.size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
        if (!Process32FirstW(snap, ref e)) { uncertain++; return 0; }
        bool cut = EnumerationFailsForTests();
        for (bool more = true; more; ) {
          if (e.pid != 0) parents[(int)e.pid] = (int)e.parent;
          if (cut) { uncertain++; return 0; }
          more = Process32NextW(snap, ref e);
        }
        if (Marshal.GetLastWin32Error() != 18) { uncertain++; return 0; }
      } finally { CloseHandle(snap); }
      int unsure = uncertain;
      var owner = new Dictionary<int, string>();
      foreach (var j in jobs) {
        int[] listed = ListChecked(j.Key);
        if (listed == null) { uncertain++; continue; }
        foreach (int pid in listed) owner[pid] = j.Key;
      }
      foreach (var h in held) if (jobs.ContainsKey(h.Value.job)) owner[h.Key] = h.Value.job;
      foreach (var f in followed) if (jobs.ContainsKey(f.Value.job)) owner[f.Key] = f.Value.job;
      var tried = new HashSet<int>();
      int n = 0;
      for (bool found = true; found; ) {
        found = false;
        foreach (var kv in parents) {
          string id;
          if (owner.ContainsKey(kv.Key) || tried.Contains(kv.Key) || !owner.TryGetValue(kv.Value, out id)) continue;
          tried.Add(kv.Key);
          if (!Take(id, kv.Key, kv.Value, at)) continue;
          Joined(id);
          owner[kv.Key] = id;
          int c; adopted.TryGetValue(id, out c); adopted[id] = c + 1;
          n++;
          found = true;
        }
      }
      // Followed processes that have ended: their children were looked at above, while their ids were still held. Only
      // after a sweep sure of everything (HR2's round 2: one that wasn't may not have found them yet), and never one
      // whose state can't be read: it stays followed, unknown.
      if (uncertain != unsure) return n;
      foreach (int pid in new List<int>(followed.Keys)) {
        uint code;
        if (!GetExitCodeProcess(followed[pid].h, out code)) { uncertain++; continue; }
        if (code == 259) continue;
        CloseHandle(followed[pid].h);
        followed.Remove(pid);
      }
      return n;
    }
  }
  /**
   * Takes an escaped process into job id: adopted into it if it is in no job, else followed. pid and parent are as a
   * snapshot taken at time "at" saw them: an id may name another process by now, so a process opened by it (the
   * candidate, or a parent not held) that was created after the snapshot isn't the one it saw (#543). Public for the
   * unit tests, which hand it stale identities.
   */
  public static bool Take(string id, int pid, int parent, long at) {
    lock (turn) {
      IntPtr job;
      if (!jobs.TryGetValue(id, out job)) return false;
      // PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION
      IntPtr c = OpenProcess(0x0001 | 0x0100 | 0x1000, false, pid);
      // ERROR_INVALID_PARAMETER: no such process (gone). Anything else (access denied): it may be one, unchecked.
      if (c == IntPtr.Zero) { if (Marshal.GetLastWin32Error() != 87) uncertain++; return false; }
      bool keep = false;
      try {
        bool inJob, inAny; uint code; long cc, pc, x, k, u;
        if (!IsProcessInJob(c, job, out inJob)) { uncertain++; return false; }
        if (inJob) return false;
        if (!GetExitCodeProcess(c, out code)) { uncertain++; return false; }
        if (code != 259) return false;
        if (!GetProcessTimes(c, out cc, out x, out k, out u)) { uncertain++; return false; }
        if (cc > at) return false;
        bool sure;
        if (!Started(parent, at, out pc, out sure)) { if (!sure) uncertain++; return false; }
        if (pc > cc) return false;
        // Only a process in no job joins: one in another job is followed (#659). Windows would nest the jobs: the Store's
        // PowerShell's is its package's, which every Store PowerShell started later joins, and when it had no parent it
        // became this launch's, so the next ones (any agent's or app's) were listed and ended with this launch. A packaged
        // app's process is followed even in no job: Windows puts it in its package's job only once it has started (a few
        // ms, more under load), and one assigned before then nests that job in this one just the same (#678).
        if (!IsProcessInJob(c, IntPtr.Zero, out inAny)) { uncertain++; return false; }
        if (!inAny && !Packaged(c) && AssignProcessToJobObject(job, c)) return true;
        if (!FollowHeld(id, pid, c, cc)) { uncertain++; return false; }
        keep = true;
        return true;
      } finally { if (!keep) CloseHandle(c); }
    }
  }
  /** Whether a process is a packaged app's (has a package identity); one that can't be told counts as packaged. */
  static bool Packaged(IntPtr proc) {
    int len = 0;
    // APPMODEL_ERROR_NO_PACKAGE
    return GetPackageFullName(proc, ref len, null) != 15700;
  }
  /** When a job's process started: held (its id kept), or looked up now, if created before "at". */
  static bool Started(int pid, long at, out long created) { bool sure; return Started(pid, at, out created, out sure); }
  /** sure: false when it couldn't be told (the parent couldn't be opened or read), true when the answer is Windows'. */
  static bool Started(int pid, long at, out long created, out bool sure) {
    Held h;
    sure = true;
    if (held.TryGetValue(pid, out h) || followed.TryGetValue(pid, out h)) { created = h.created; return true; }
    created = 0;
    IntPtr p = OpenProcess(0x1000, false, pid);
    if (p == IntPtr.Zero) { sure = false; return false; }
    long x, k, u;
    try {
      if (!GetProcessTimes(p, out created, out x, out k, out u)) { sure = false; return false; }
      return created <= at;
    } finally { CloseHandle(p); }
  }
  /**
   * Holds a process the port says joined job id, if it is in that job: a notification read late may carry an id that
   * names another process by now (#543). Public for the unit tests.
   */
  public static bool Hold(string id, int pid) {
    lock (turn) {
      IntPtr job;
      if (held.ContainsKey(pid) || !jobs.TryGetValue(id, out job)) return false;
      // SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION: Settle asks whether it has exited.
      IntPtr h = OpenProcess(0x100000 | 0x1000, false, pid);
      if (h == IntPtr.Zero) return false;
      bool inJob; long created, x, k, u;
      if (IsProcessInJob(h, job, out inJob) && inJob && GetProcessTimes(h, out created, out x, out k, out u)) {
        held[pid] = new Held { job = id, h = h, created = created };
        return true;
      }
      CloseHandle(h);
      return false;
    }
  }
  /** Follows pid in job id with a handle of the given access (the unit tests: one that can't end it). */
  public static bool Follow(string id, int pid, uint access) {
    lock (turn) {
      IntPtr h = OpenProcess(access | 0x1000, false, pid);
      long created, x, k, u;
      if (h == IntPtr.Zero || !jobs.ContainsKey(id) || !GetProcessTimes(h, out created, out x, out k, out u)) { if (h != IntPtr.Zero) CloseHandle(h); return false; }
      if (!FollowHeld(id, pid, h, created)) { CloseHandle(h); return false; }
      return true;
    }
  }
  public static bool IsHeld(int pid) { lock (turn) return held.ContainsKey(pid); }
  public static bool IsFollowed(int pid) { lock (turn) return followed.ContainsKey(pid); }
  /** When pid started (FILETIME), while it runs; 0 when it doesn't (gone, exited) or can't be read. */
  public static long CreatedOf(int pid) {
    IntPtr p = OpenProcess(0x1000, false, pid);
    if (p == IntPtr.Zero) return 0;
    try { uint code; long c, x, k, u; return GetExitCodeProcess(p, out code) && code == 259 && GetProcessTimes(p, out c, out x, out k, out u) ? c : 0; } finally { CloseHandle(p); }
  }
  /** "pid:created,…" as pairs; malformed entries are left out. */
  static List<KeyValuePair<int, long>> Pairs(string list) {
    var r = new List<KeyValuePair<int, long>>();
    foreach (string e in list.Split(',')) {
      string[] pc = e.Split(':'); int pid; long created;
      if (pc.Length == 2 && int.TryParse(pc[0], out pid) && long.TryParse(pc[1], out created) && pid > 0 && created > 0) r.Add(new KeyValuePair<int, long>(pid, created));
    }
    return r;
  }
  /**
   * Processes kept from before Combwork restarted, by id and start time ("pid:created,…", #614): those still running as
   * the same process, as JSON ["pid:created", …]: an identity is the pair, never the id alone. An id that names
   * another process by now (another start time) is left out.
   */
  public static string Identify(string list) {
    var b = new StringBuilder("[");
    bool first = true;
    foreach (var p in Pairs(list)) {
      if (CreatedOf(p.Key) != p.Value) continue;
      b.Append(first ? "" : ",").Append('"').Append(p.Key).Append(':').Append(p.Value).Append('"');
      first = false;
    }
    return b.Append(']').ToString();
  }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr p, int flags, StringBuilder name, ref int size);
  /**
   * The executables of processes by id and start time ("pid:created,…", HI-2309: a system broker is known by its path),
   * as JSON {"pid:created": "path"} for each still running as that process; "" where it runs but its path can't be read
   * (access denied, say). One gone, or whose id names another process by now, is left out.
   */
  public static string Paths(string list) {
    var b = new StringBuilder("{");
    bool first = true;
    foreach (var e in Pairs(list)) {
      string path = "";
      // PROCESS_QUERY_LIMITED_INFORMATION
      IntPtr p = OpenProcess(0x1000, false, e.Key);
      // ERROR_INVALID_PARAMETER: no process has the id. Anything else: one does, unread.
      if (p == IntPtr.Zero) { if (Marshal.GetLastWin32Error() == 87) continue; }
      else {
        try {
          uint code; long c, x, k, u;
          if (GetProcessTimes(p, out c, out x, out k, out u)) {
            if (c != e.Value) continue;
            if (GetExitCodeProcess(p, out code)) {
              if (code != 259) continue;
              var name = new StringBuilder(32768); int n = name.Capacity;
              if (QueryFullProcessImageNameW(p, 0, name, ref n)) path = name.ToString(0, n);
            }
          }
        } finally { CloseHandle(p); }
      }
      b.Append(first ? "" : ",").Append(Q(e.Key + ":" + e.Value)).Append(':').Append(Q(path));
      first = false;
    }
    return b.Append('}').ToString();
  }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr p, int cls, ref BasicInfo info, int len, out int ret);
  [StructLayout(LayoutKind.Sequential)] struct BasicInfo { public IntPtr exit, peb, affinity, priority, pid, parent; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr p, IntPtr at, byte[] buf, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsWow64Process(IntPtr p, out bool wow);
  /** n bytes of another process's memory at at, all of them, or null. */
  static byte[] ReadAt(IntPtr p, long at, int n) {
    var b = new byte[n]; IntPtr got;
    return at != 0 && ReadProcessMemory(p, new IntPtr(at), b, new IntPtr(n), out got) && got.ToInt64() == n ? b : null;
  }
  /**
   * A process's current folder (HI-2467: what Windows refuses to rename while it is one), read from its PEB: its
   * ProcessParameters (PEB + 0x20), whose CurrentDirectory.DosPath is a UNICODE_STRING at + 0x38 (length, maximum, its
   * buffer at + 0x40). That layout is x64's (and an x64 or ARM64 process's on ARM64): only a 64-bit helper reads it, and
   * only of a 64-bit process (a WOW64 one keeps a 32-bit copy). "" for anything else, or a read that fails or is
   * inconsistent (an odd or empty length, longer than its maximum): never a guess. p needs QUERY_LIMITED and VM_READ.
   */
  static string CwdOf(IntPtr p) {
    if (IntPtr.Size != 8) return "";
    bool wow;
    if (!IsWow64Process(p, out wow) || wow) return "";
    var bi = new BasicInfo(); int ret;
    if (NtQueryInformationProcess(p, 0, ref bi, Marshal.SizeOf(typeof(BasicInfo)), out ret) != 0) return "";
    byte[] pp = ReadAt(p, bi.peb.ToInt64() + 0x20, 8);
    if (pp == null) return "";
    byte[] cd = ReadAt(p, BitConverter.ToInt64(pp, 0) + 0x38, 16);
    if (cd == null) return "";
    int len = BitConverter.ToUInt16(cd, 0), max = BitConverter.ToUInt16(cd, 2);
    if (len == 0 || len % 2 != 0 || len > max) return "";
    byte[] s = ReadAt(p, BitConverter.ToInt64(cd, 8), len);
    return s == null ? "" : Encoding.Unicode.GetString(s);
  }
  /**
   * The processes running an executable named in names (lower case, comma separated), and (pids, "n-n-…": the unit and
   * e2e tests' stand-ins, which the host sends only for test copies) those ids, each with its executable's path and
   * current folder (HI-2467: which of Windows' brokers keeps a slot as its folder). JSON {"complete": bool, "processes":
   * [{"id": "pid:created", "path", "cwd"}]}: "" where one is unread (access denied, CwdOf's cases). complete is false
   * when the answer leaves some out: more than max matched, or one runs that couldn't be opened at all. A process gone
   * since the snapshot is left out (it holds nothing). A snapshot not read whole is an error, never "none".
   */
  public static string WorkingIn(string names, string pids, int max) {
    var want = new HashSet<string>(names.ToLowerInvariant().Split(','));
    var also = new HashSet<uint>();
    foreach (string s in (pids ?? "").Split('-')) { uint n; if (uint.TryParse(s, out n) && n > 0) also.Add(n); }
    var found = new List<int>();
    bool complete = true;
    IntPtr snap = SnapshotFailsForTests() ? IntPtr.Zero : CreateToolhelp32Snapshot(2, 0);
    if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return Q("error: no snapshot");
    try {
      var e = new ProcessEntry(); e.size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
      if (!Process32FirstW(snap, ref e)) return Q("error: no snapshot");
      for (bool more = true; more; ) {
        if (e.pid != 0 && (want.Contains((e.exe ?? "").ToLowerInvariant()) || also.Contains(e.pid))) {
          if (found.Count < max) found.Add((int)e.pid); else complete = false;
        }
        more = Process32NextW(snap, ref e);
      }
      if (Marshal.GetLastWin32Error() != 18) return Q("error: snapshot cut short");
    } finally { CloseHandle(snap); }
    var b = new StringBuilder("[");
    bool first = true;
    foreach (int pid in found) {
      // QUERY_LIMITED and VM_READ for its folder; refused that, QUERY_LIMITED alone for its path.
      IntPtr p = OpenProcess(0x1010, false, pid);
      bool read = p != IntPtr.Zero;
      if (!read) p = OpenProcess(0x1000, false, pid);
      // ERROR_INVALID_PARAMETER: gone since the snapshot. Anything else: it runs, unread, so the answer isn't whole.
      if (p == IntPtr.Zero) { if (Marshal.GetLastWin32Error() != 87) complete = false; continue; }
      try {
        uint code; long c, x, k, u;
        if (!GetProcessTimes(p, out c, out x, out k, out u) || !GetExitCodeProcess(p, out code)) { complete = false; continue; }
        if (code != 259) continue;
        string path = "";
        var name = new StringBuilder(32768); int n = name.Capacity;
        if (QueryFullProcessImageNameW(p, 0, name, ref n)) path = name.ToString(0, n);
        string cwd = read ? CwdOf(p) : "";
        b.Append(first ? "" : ",").Append("{\"id\":").Append(Q(pid + ":" + c)).Append(",\"path\":").Append(Q(path)).Append(",\"cwd\":").Append(Q(cwd)).Append('}');
        first = false;
      } finally { CloseHandle(p); }
    }
    return "{\"complete\":" + (complete ? "true" : "false") + ",\"processes\":" + b.Append(']').ToString() + "}";
  }
  /**
   * Ends processes by id and start time ("pid:created,…", #614), each only while it is still that process: one gone, or
   * whose id names another process by now, counts as ended. JSON {"ended":n,"failed":n}: those failed still run.
   */
  public static string EndExact(string list) {
    int ended = 0, failed = 0;
    foreach (var e in Pairs(list)) {
      // PROCESS_TERMINATE | SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
      IntPtr p = OpenProcess(0x0001 | 0x100000 | 0x1000, false, e.Key);
      if (p == IntPtr.Zero) {
        // ERROR_INVALID_PARAMETER: no process has the id. Anything else: one does, and Windows won't let Combwork end it.
        if (Marshal.GetLastWin32Error() == 87) ended++; else failed++;
        continue;
      }
      try {
        uint code; long c, x, k, u;
        if (!GetProcessTimes(p, out c, out x, out k, out u) || c != e.Value || !GetExitCodeProcess(p, out code) || code != 259) { ended++; continue; }
        if (TerminateProcess(p, 1) && WaitForSingleObject(p, 2000) == 0) ended++; else failed++;
      } finally { CloseHandle(p); }
    }
    return "{\"ended\":" + ended + ",\"failed\":" + failed + "}";
  }
  /** A process EndTree will end: its id and start time, and its handle, held from when it was checked until it is ended. */
  public struct Picked { public int pid; public long created; public IntPtr h; }
  /**
   * What EndTree ends (#1008), the OS's answers passed in (the unit tests give their own): each root ("pid:created")
   * only while it is still that process, and below it, by the parent ids of a snapshot taken at "at", each child that is
   * still running, started after its parent and not after the snapshot. Each is checked through a handle opened on it
   * and held (open; close lets one go), so its id can't name another process before it is ended: a process an id names
   * by now (started after the snapshot), and a root that has gone are never taken or followed. What Combwork can't end is
   * never passed over in silence: a root that runs but can't be opened or read is in failed ("pid:created"), and so is a
   * child that runs and can't be opened to end it but whose start time a query-only look (peek: its start time, 0 when
   * it has gone, -1 when it can't be read) shows to be one of the run's; a child that runs and can't be told either way
   * is in unverified (its id). Nothing below those is followed.
   */
  public static List<Picked> PickTree(string list, Dictionary<int, List<int>> children, long at, Func<int, IntPtr> open, Func<int, bool> absent, Func<IntPtr, long> createdOf, Func<IntPtr, bool> running, Action<IntPtr> close, Func<int, long> peek, List<string> failed, List<int> unverified) {
    var picked = new List<Picked>();
    var seen = new HashSet<int>();
    var queue = new Queue<Picked>();
    foreach (var r in Pairs(list)) {
      if (seen.Contains(r.Key)) continue;
      IntPtr h = open(r.Key);
      if (h == IntPtr.Zero) { if (!absent(r.Key)) failed.Add(r.Key + ":" + r.Value); continue; }
      long rc = createdOf(h);
      bool runs = running(h);
      if (rc != r.Value || !runs) {
        close(h);
        // Running, its start time unreadable: it may well be the root, and still runs.
        if (rc == 0 && runs) failed.Add(r.Key + ":" + r.Value);
        continue;
      }
      seen.Add(r.Key);
      queue.Enqueue(new Picked { pid = r.Key, created = r.Value, h = h });
    }
    while (queue.Count > 0) {
      var p = queue.Dequeue();
      picked.Add(p);
      List<int> c;
      if (!children.TryGetValue(p.pid, out c)) continue;
      foreach (int k in c) {
        if (seen.Contains(k)) continue;
        IntPtr h = open(k);
        if (h == IntPtr.Zero) {
          if (absent(k)) continue;
          // It runs, and Combwork can't end it: said if it is the run's (or might be), never passed over.
          long pc = peek(k);
          if (pc == -1) unverified.Add(k);
          else if (pc > 0 && pc >= p.created && pc <= at) failed.Add(k + ":" + pc);
          continue;
        }
        long kc = createdOf(h);
        bool kr = running(h);
        if (kc == 0 || kc < p.created || kc > at || !kr) {
          close(h);
          if (kc == 0 && kr) unverified.Add(k);
          continue;
        }
        seen.Add(k);
        queue.Enqueue(new Picked { pid = k, created = kc, h = h });
      }
    }
    return picked;
  }
  /**
   * Ends processes by id and start time ("pid:created,…") with all they started that runs now (#1008: a test run's
   * whole tree), as PickTree picks them, each through the handle it was checked with. JSON {"ended":n,"failed":n,
   * "failedIds":["pid:created",…],"unverified":[pid,…]}: those failed still run (one Combwork couldn't open among them), to
   * try again; unverified, the ids of the run's children (as far as Combwork can tell) that run and it could neither end nor check.
   */
  public static string EndTree(string list) {
    var children = new Dictionary<int, List<int>>();
    // Taken before the snapshot: a process created after it can't be one the snapshot saw.
    long at; GetSystemTimeAsFileTime(out at);
    // TH32CS_SNAPPROCESS
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap != IntPtr.Zero && snap != new IntPtr(-1)) {
      try {
        var e = new ProcessEntry(); e.size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
        for (bool more = Process32FirstW(snap, ref e); more; more = Process32NextW(snap, ref e)) {
          if (e.pid == 0) continue;
          List<int> c;
          if (!children.TryGetValue((int)e.parent, out c)) children[(int)e.parent] = c = new List<int>();
          c.Add((int)e.pid);
        }
      } finally { CloseHandle(snap); }
    }
    var failed = new List<string>();
    int error = 0;
    // PROCESS_TERMINATE | SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
    Func<int, IntPtr> open = (pid) => { IntPtr h = OpenProcess(0x0001 | 0x100000 | 0x1000, false, pid); error = h == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0; return h; };
    // ERROR_INVALID_PARAMETER: no process has the id.
    Func<int, bool> absent = (pid) => error == 87;
    Func<IntPtr, long> createdOf = (h) => { long c, x, k, u; return GetProcessTimes(h, out c, out x, out k, out u) ? c : 0; };
    Func<IntPtr, bool> running = (h) => { uint code; return GetExitCodeProcess(h, out code) && code == 259; };
    // PROCESS_QUERY_LIMITED_INFORMATION alone: what a process Combwork can't end is, if it can tell.
    Func<int, long> peek = (pid) => {
      IntPtr q = OpenProcess(0x1000, false, pid);
      if (q == IntPtr.Zero) return Marshal.GetLastWin32Error() == 87 ? 0 : -1;
      try { long c = createdOf(q); return !running(q) ? 0 : c == 0 ? -1 : c; } finally { CloseHandle(q); }
    };
    var unverified = new List<int>();
    var picked = PickTree(list, children, at, open, absent, createdOf, running, (h) => CloseHandle(h), peek, failed, unverified);
    int ended = 0;
    foreach (var p in picked) {
      try {
        if (!running(p.h) || (TerminateProcess(p.h, 1) && WaitForSingleObject(p.h, 2000) == 0)) ended++;
        else failed.Add(p.pid + ":" + p.created);
      } finally { CloseHandle(p.h); }
    }
    var b = new StringBuilder("{\"ended\":" + ended + ",\"failed\":" + failed.Count + ",\"failedIds\":[");
    for (int i = 0; i < failed.Count; i++) b.Append(i > 0 ? "," : "").Append(Q(failed[i]));
    b.Append("],\"unverified\":[");
    for (int i = 0; i < unverified.Count; i++) b.Append(i > 0 ? "," : "").Append(unverified[i]);
    return b.Append("]}").ToString();
  }
  /** Exits gathered for the next Settle: each pid with the entry held for it as its exit was read (null: none). */
  static List<KeyValuePair<int, Held>> exits = new List<KeyValuePair<int, Held>>();
  /** At most this many exits are kept for a sure sweep (Settle); past it, their jobs' ancestry is lost (ancestryLost). */
  const int MAX_PENDING_EXITS = 4096;
  /** Jobs whose exited processes were let go before a sure sweep (HI-2055): never "ended" by the keeper. */
  static HashSet<string> ancestryLost = new HashSet<string>();
  /** When the gathered exits are settled (on clock), ${EXIT_BATCH_MS} ms after the first of them. */
  static readonly System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
  static long due = 0;
  /**
   * A notification from the port for job id: a process joining is held, one ending is gathered for the next Settle with
   * the entry its job held for it then. Public for the unit tests, which give the events in an order of their own (#604).
   */
  public static void Notify(string id, uint message, int pid) {
    lock (turn) {
      // JOB_OBJECT_MSG_NEW_PROCESS
      if (message == 6) { if (Hold(id, pid)) Joined(id); return; }
      // JOB_OBJECT_MSG_EXIT_PROCESS, JOB_OBJECT_MSG_ABNORMAL_EXIT_PROCESS
      if (message != 7 && message != 8) return;
      Held h;
      if (!held.TryGetValue(pid, out h) || h.job != id) h = null;
      if (exits.Count == 0) due = clock.ElapsedMilliseconds + ${EXIT_BATCH_MS};
      exits.Add(new KeyValuePair<int, Held>(pid, h));
    }
  }
  /**
   * Sweeps for what the gathered exits left outside, then lets go of what was held for them. Only the entry held as an
   * exit was read, and only once its process has exited (#604): its job forgotten meanwhile, the id is free, and may
   * name another job's process by now, held under the same id; and a late join may have held, by an id already free
   * again, another process of the same job, which still runs. Either way that entry is another process's, let go at its
   * own exit. Public for the unit tests.
   */
  public static void Settle() {
    lock (turn) {
      // A sweep that wasn't sure keeps what was held for the exits (HR2's round 2): an exited parent's identity is what
      // ties its escaped children to its job, so it is let go only after a sweep that was; tried again in a moment.
      int before = uncertain;
      try { Sweep(); } catch { uncertain++; }
      if (uncertain != before) {
        if (exits.Count <= MAX_PENDING_EXITS) { due = clock.ElapsedMilliseconds + ${EXIT_BATCH_MS}; return; }
        // Kept too long (sweeps unsure for hours): let go, and their jobs can never be told complete by the keeper.
        foreach (var e in exits) if (e.Value != null) ancestryLost.Add(e.Value.job);
      }
      try {
        foreach (var e in exits) {
          Held h;
          if (e.Value == null || !held.TryGetValue(e.Key, out h) || !ReferenceEquals(h, e.Value) || WaitForSingleObject(h.h, 0) != 0) continue;
          CloseHandle(h.h);
          held.Remove(e.Key);
        }
      } finally { exits.Clear(); }
    }
  }
  /** The job holding pid (Hold), or null. Public for the unit tests. */
  public static string HeldBy(int pid) { lock (turn) { Held h; return held.TryGetValue(pid, out h) ? h.job : null; } }
  /**
   * The port's thread: holds each process as it joins a job. Those that end are swept for together, at most
   * ${EXIT_BATCH_MS} ms after the first of them (a build ends hundreds of processes, and a sweep's snapshot of every
   * process costs a few ms), adopting what they left outside; then they are let go.
   */
  static void Listen() {
    for (;;) {
      bool waiting; long left;
      lock (turn) { waiting = exits.Count > 0; left = due - clock.ElapsedMilliseconds; }
      if (waiting && left <= 0) {
        try { Settle(); } catch { }
        continue;
      }
      uint message; UIntPtr key; IntPtr detail;
      if (!GetQueuedCompletionStatus(port, out message, out key, out detail, waiting ? (uint)left : 0xFFFFFFFF)) continue;
      int pid = (int)detail.ToInt64();
      try {
        lock (turn) {
          string id;
          if (byKey.TryGetValue(key.ToUInt64(), out id)) Notify(id, message, pid);
        }
      } catch { }
      Tell();
    }
  }
  public static string Add(string id, int pid) {
    if (sweeper == null) sweeper = new System.Threading.Timer(_ => { try { Sweep(); Tell(); } catch { } }, null, ${SWEEP_MS}, ${SWEEP_MS});
    // A new launch: its CLI joining is told, whatever was told before (main may not have listed it since).
    lock (turn) Untold(id);
    if (port == IntPtr.Zero) {
      port = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1);
      if (port != IntPtr.Zero) new System.Threading.Thread(Listen) { IsBackground = true }.Start();
    }
    IntPtr job;
    if (!jobs.TryGetValue(id, out job)) {
      job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
      if (job == IntPtr.Zero) return "create failed: " + Marshal.GetLastWin32Error();
      jobs[id] = job;
      // JobObjectAssociateCompletionPortInformation: without it, escaped children are still adopted by the sweeps.
      if (port != IntPtr.Zero) {
        ulong k = nextKey++;
        var info = new PortInfo { key = new IntPtr((long)k), port = port };
        if (SetInformationJobObject(job, 7, ref info, Marshal.SizeOf(typeof(PortInfo)))) byKey[k] = id;
      }
    }
    // PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION
    IntPtr p = OpenProcess(0x0001 | 0x0100 | 0x1000, false, pid);
    if (p == IntPtr.Zero) return "the process has gone (" + Marshal.GetLastWin32Error() + ")";
    uint code;
    // STILL_ACTIVE: a process that has exited (its id kept alive by a handle) isn't the launch's any more.
    if (!GetExitCodeProcess(p, out code) || code != 259) { CloseHandle(p); return "the process has exited"; }
    bool ok = AssignProcessToJobObject(job, p);
    int err = Marshal.GetLastWin32Error();
    CloseHandle(p);
    return ok ? "ok" : "assign failed: " + err;
  }
  public static int[] List(string id) {
    IntPtr job;
    if (!jobs.TryGetValue(id, out job)) return new int[0];
    for (int n = 256; n <= 65536; n *= 4) {
      int size = 2 * 4 + IntPtr.Size * n;
      IntPtr buf = Marshal.AllocHGlobal(size);
      try {
        if (!QueryInformationJobObject(job, 3, buf, size, IntPtr.Zero)) { if (Marshal.GetLastWin32Error() == 234) continue; return new int[0]; }
        int count = Marshal.ReadInt32(buf, 4);
        int[] r = new int[count];
        for (int i = 0; i < count; i++) r[i] = (int)Marshal.ReadIntPtr(buf, 8 + i * IntPtr.Size).ToInt64();
        return r;
      } finally { Marshal.FreeHGlobal(buf); }
    }
    return new int[0];
  }
  /**
   * Ends the job's processes and the ones it follows. False when any still runs (a followed one Windows wouldn't end
   * stays followed and listed, so End can be tried again); one already gone counts as ended.
   */
  public static bool Kill(string id) {
    IntPtr job;
    Sweep();
    if (!jobs.TryGetValue(id, out job) || !TerminateJobObject(job, 1)) return false;
    bool all = true;
    foreach (var f in followed) {
      uint code;
      if (f.Value.job != id || TerminateProcess(f.Value.h, 1)) continue;
      if (!GetExitCodeProcess(f.Value.h, out code) || code == 259) all = false;
    }
    return all;
  }
  public static void Forget(string id) {
    IntPtr job;
    if (!jobs.TryGetValue(id, out job)) return;
    CloseHandle(job);
    jobs.Remove(id);
    adopted.Remove(id);
    told.Remove(id);
    closing.Remove(id);
    foreach (var k in new List<ulong>(byKey.Keys)) if (byKey[k] == id) byKey.Remove(k);
    foreach (var pid in new List<int>(held.Keys)) if (held[pid].job == id) { CloseHandle(held[pid].h); held.Remove(pid); }
    foreach (var pid in new List<int>(followed.Keys)) if (followed[pid].job == id) { CloseHandle(followed[pid].h); followed.Remove(pid); }
  }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool MoveFileExW(string from, string to, uint flags);
  /**
   * The keeper (HI-2055): once its Combwork has gone (its input ended: a quit, a crash), this helper stays while an agent's
   * launch job it holds still has a process, the only one that can tell those jobs complete, and writes each one's state
   * to keepDir as keeper-<job>.json: "live" with its members (by id, start time and name: no command line, which can
   * hold a secret) while it has any, "ended" once it is seen empty, then lets it go; it exits once it holds none. Nothing
   * is ended by it. The next Combwork frees a slot's writer only by an "ended" from the helper its run was bound to. Unset
   * (keepDir null), it exits at the end of its input as before.
   */
  static string keepDir;
  static string keepCombwork;
  static string keepSelf;
  /** Configures the keeper: its Combwork's identity ("pid:started", as its slot writers name it) and the folder. Its own identity, "pid:created". */
  public static string Keeper(string combwork, string dir) {
    int me = System.Diagnostics.Process.GetCurrentProcess().Id;
    keepCombwork = combwork;
    keepDir = dir;
    keepSelf = me + ":" + CreatedOf(me);
    return keepSelf;
  }
  /** The job's processes, or null when Windows couldn't say (never taken for empty). */
  static int[] ListChecked(string id) {
    IntPtr job;
    if (!jobs.TryGetValue(id, out job)) return null;
    for (int n = 256; n <= 65536; n *= 4) {
      int size = 2 * 4 + IntPtr.Size * n;
      IntPtr buf = Marshal.AllocHGlobal(size);
      try {
        if (!QueryInformationJobObject(job, 3, buf, size, IntPtr.Zero)) { if (Marshal.GetLastWin32Error() == 234) continue; return null; }
        int count = Marshal.ReadInt32(buf, 4);
        int[] r = new int[count];
        for (int i = 0; i < count; i++) r[i] = (int)Marshal.ReadIntPtr(buf, 8 + i * IntPtr.Size).ToInt64();
        return r;
      } finally { Marshal.FreeHGlobal(buf); }
    }
    return null;
  }
  /** Its whole membership as Members gives it (the job's and the running processes it follows), or null when unreadable. Under the turn. */
  static int[] MembersChecked(string id) {
    var listed = ListChecked(id);
    if (listed == null) return null;
    var members = new List<int>(listed);
    foreach (var f in followed) {
      if (f.Value.job != id) continue;
      uint code;
      if (!GetExitCodeProcess(f.Value.h, out code)) return null;
      if (code == 259) members.Add(f.Key);
    }
    return members.ToArray();
  }
  /**
   * A job as it is now, observed as the keeper observes it (HI-2313: one policy for its states and its answers): false
   * when it holds no such job (let go, or never its own). Its members only after a sweep that was sure of everything (a
   * failed one could miss an escaped child) and its membership read whole, else null; lost: its ancestry was let go
   * unsure, so it can never be told complete.
   */
  static bool Look(string id, out int[] members, out bool lost) {
    lock (turn) {
      members = null;
      lost = false;
      if (!jobs.ContainsKey(id)) return false;
      uncertain = 0;
      try { Sweep(); } catch { uncertain++; }
      members = uncertain == 0 ? MembersChecked(id) : null;
      lost = ancestryLost.Contains(id);
      return true;
    }
  }
  /** A job's state as JSON, its members (null: none said) by id, start time and name (never a command line). */
  static string StateJson(string id, string state, string observed, int[] members) {
    var b = new StringBuilder("{\"v\":1,\"run\":" + Q(id) + ",\"helper\":" + Q(keepSelf) + ",\"app\":" + Q(keepCombwork) + ",\"state\":" + Q(state) + ",\"observed\":" + Q(observed));
    if (members != null) {
      b.Append(",\"total\":").Append(members.Length).Append(",\"members\":[");
      for (int i = 0; i < members.Length && i < ${MAX_LISTED}; i++) {
        string name = "";
        try { using (var p = System.Diagnostics.Process.GetProcessById(members[i])) name = p.ProcessName; } catch { }
        b.Append(i > 0 ? "," : "").Append("{\"pid\":").Append(members[i]).Append(",\"created\":\"").Append(CreatedOf(members[i])).Append("\",\"name\":").Append(Q(name)).Append("}");
      }
      b.Append("]");
    }
    return b.Append(",\"at\":").Append(DateTime.UtcNow.ToFileTimeUtc()).Append("}").ToString();
  }
  /**
   * The answer to a later Combwork asking for a run's job now (HI-2313): observed for the asking (Look), never a state written
   * before. "now" with "complete" and its members (none: empty now); "now" with "unsure" when the observation wasn't sure
   * or its ancestry was let go unsure; "unknown" for a job it doesn't hold. Ends and changes nothing.
   */
  public static string Observation(string id) {
    if (keepSelf == null || !System.Text.RegularExpressions.Regex.IsMatch(id ?? "", "^[A-Za-z0-9_-]{1,64}$")) return Q("error: no such run");
    int[] m;
    bool lost;
    if (!Look(id, out m, out lost)) return StateJson(id, "unknown", "none", null);
    if (m == null || lost) return StateJson(id, "now", "unsure", null);
    Array.Sort(m);
    return StateJson(id, "now", "complete", m);
  }
  [StructLayout(LayoutKind.Sequential)] struct PipeSecurity { public int length; public IntPtr descriptor; public bool inherit; }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateNamedPipeW(string name, int openMode, int pipeMode, int instances, int outSize, int inSize, int timeout, ref PipeSecurity sa);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, int revision, out IntPtr sd, IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ConnectNamedPipe(IntPtr pipe, IntPtr ov);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DisconnectNamedPipe(IntPtr pipe);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr h, IntPtr buf, int n, IntPtr read, IntPtr ov);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(IntPtr h, IntPtr buf, int n, IntPtr written, IntPtr ov);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetOverlappedResult(IntPtr h, IntPtr ov, out int n, bool wait);
  [DllImport("kernel32.dll")] static extern bool CancelIoEx(IntPtr h, IntPtr ov);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateEventW(IntPtr sa, bool manual, bool initial, IntPtr name);
  /** The pipe a keeper answers on, named after its identity (its binding names it). */
  public static string PipeName() { return @"\\.\pipe\combwork-keeper-" + (keepSelf ?? "").Replace(':', '-'); }
  /** How long one asking may take, from connecting to the answer read (a client that stops is let go). */
  const int ASK_MS = 2000;
  /**
   * One overlapped step on the pipe (0 connect, 1 read, 2 write), bounded by ms (-1: none): the bytes moved, or -1 when
   * it failed or didn't finish in time (then cancelled, and waited for, so its buffer is free).
   */
  static int Step(IntPtr pipe, IntPtr ov, IntPtr ev, int kind, IntPtr buf, int n, int ms) {
    int size = 2 * IntPtr.Size + 8;
    for (int i = 0; i < size + IntPtr.Size; i++) Marshal.WriteByte(ov, i, 0);
    Marshal.WriteIntPtr(ov, size, ev);
    bool ok = kind == 0 ? ConnectNamedPipe(pipe, ov) : kind == 1 ? ReadFile(pipe, buf, n, IntPtr.Zero, ov) : WriteFile(pipe, buf, n, IntPtr.Zero, ov);
    int err = ok ? 0 : Marshal.GetLastWin32Error();
    // ERROR_PIPE_CONNECTED: a client connected before it was asked.
    if (kind == 0 && err == 535) return 0;
    if (!ok && err != 997) return -1;
    int moved;
    if (WaitForSingleObject(ev, ms < 0 ? 0xFFFFFFFF : (uint)Math.Max(0, ms)) != 0) {
      CancelIoEx(pipe, ov);
      GetOverlappedResult(pipe, ov, out moved, true);
      return -1;
    }
    return GetOverlappedResult(pipe, ov, out moved, false) ? moved : -1;
  }
  static int Left(DateTime deadline) { return (int)Math.Max(0, (deadline - DateTime.UtcNow).TotalMilliseconds); }
  /**
   * Its pipe, while it keeps (HI-2313): one client at a time, each asking one line ("observe <run>", at most 256 bytes)
   * and read its answer (Observation), all within ASK_MS from connecting, then let go. Only this user's processes, never
   * a remote client, may open it, and only the first instance by its name: one taken already, nothing is served (a later
   * Combwork asking it fails closed). Nothing a client sends ends or changes anything.
   */
  static void Serve() {
    IntPtr pipe = new IntPtr(-1), ev = IntPtr.Zero, ov = IntPtr.Zero, buf = IntPtr.Zero;
    try {
      IntPtr sd;
      string sid = System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
      if (!ConvertStringSecurityDescriptorToSecurityDescriptorW("D:P(A;;GA;;;" + sid + ")", 1, out sd, IntPtr.Zero)) return;
      var sa = new PipeSecurity();
      sa.length = Marshal.SizeOf(typeof(PipeSecurity));
      sa.descriptor = sd;
      // PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED; PIPE_TYPE_BYTE | PIPE_REJECT_REMOTE_CLIENTS.
      pipe = CreateNamedPipeW(PipeName(), 0x3 | 0x80000 | 0x40000000, 0x8, 1, 65536, 4096, 0, ref sa);
      if (pipe == new IntPtr(-1)) return;
      ev = CreateEventW(IntPtr.Zero, true, false, IntPtr.Zero);
      ov = Marshal.AllocHGlobal(2 * IntPtr.Size + 8 + IntPtr.Size);
      buf = Marshal.AllocHGlobal(65536 + 512);
      if (ev == IntPtr.Zero) return;
      while (true) {
        if (Step(pipe, ov, ev, 0, IntPtr.Zero, 0, -1) < 0) { DisconnectNamedPipe(pipe); continue; }
        try { Converse(pipe, ov, ev, buf); } catch { }
        DisconnectNamedPipe(pipe);
      }
    } catch { } finally {
      if (pipe != new IntPtr(-1)) CloseHandle(pipe);
      if (ev != IntPtr.Zero) CloseHandle(ev);
      if (ov != IntPtr.Zero) Marshal.FreeHGlobal(ov);
      if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf);
    }
  }
  /** One client's asking, within ASK_MS: its line, the answer, then its end (so the answer is read before it is let go). */
  static void Converse(IntPtr pipe, IntPtr ov, IntPtr ev, IntPtr buf) {
    var deadline = DateTime.UtcNow.AddMilliseconds(ASK_MS);
    int n = 0, nl = -1;
    while (nl < 0 && n < 257) {
      int got = Step(pipe, ov, ev, 1, buf + n, 257 - n, Left(deadline));
      if (got <= 0) return;
      for (int i = n; i < n + got; i++) if (Marshal.ReadByte(buf, i) == (byte)'\n') { nl = i; break; }
      n += got;
    }
    if (nl < 0) return;
    var line = new byte[nl];
    Marshal.Copy(buf, line, 0, nl);
    string asked = Encoding.ASCII.GetString(line).TrimEnd('\r');
    string answer = asked.StartsWith("observe ") ? Observation(asked.Substring(8)) : Q("error: unknown request");
    byte[] bytes = Encoding.UTF8.GetBytes(answer + "\n");
    if (bytes.Length > 65536) bytes = Encoding.UTF8.GetBytes(Q("error: too long") + "\n");
    Marshal.Copy(bytes, 0, buf, bytes.Length);
    for (int sent = 0; sent < bytes.Length; ) {
      int put = Step(pipe, ov, ev, 2, buf + sent, bytes.Length - sent, Left(deadline));
      if (put <= 0) return;
      sent += put;
    }
    // Its end (it read the answer), or the deadline.
    while (Step(pipe, ov, ev, 1, buf, 512, Left(deadline)) > 0) { }
  }
  /** A job's state written whole (a temp file, then replaced through to the disk): whether it was. */
  static bool WriteState(string id, string state, int[] members) {
    if (keepDir == null || !System.Text.RegularExpressions.Regex.IsMatch(id, "^[A-Za-z0-9_-]{1,64}$")) return false;
    var b = new StringBuilder(StateJson(id, state, "complete", members));
    string path = System.IO.Path.Combine(keepDir, "keeper-" + id + ".json");
    string tmp = path + "." + System.Diagnostics.Process.GetCurrentProcess().Id + ".tmp";
    try {
      System.IO.Directory.CreateDirectory(keepDir);
      using (var f = new System.IO.FileStream(tmp, System.IO.FileMode.Create, System.IO.FileAccess.Write, System.IO.FileShare.None, 4096, System.IO.FileOptions.WriteThrough)) {
        byte[] bytes = Encoding.UTF8.GetBytes(b.ToString());
        f.Write(bytes, 0, bytes.Length);
        f.Flush(true);
      }
      // MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH
      if (MoveFileExW(tmp, path, 0x1 | 0x8)) return true;
    } catch { }
    try { System.IO.File.Delete(tmp); } catch { }
    return false;
  }
  /**
   * Its input has ended (HI-2055): the merge queue's jobs close at once, ending what is in them as before (#1360), and,
   * configured, it keeps each agent launch's job it still holds, sweeping as it did, until each is seen empty (an
   * "ended" state, written once), then exits. A job it can't read is looked at again; one whose "ended" can't be
   * written is let go with none (its slot stays held). It says "keeping" once, so a quitting Combwork stops waiting for it.
   */
  public static void Keep() {
    List<string> mine;
    lock (turn) {
      foreach (var id in new List<string>(closing.Keys)) Forget(id);
      mine = keepDir == null ? new List<string>() : new List<string>(jobs.Keys);
    }
    if (mine.Count == 0) return;
    try { Console.Out.WriteLine("keeping"); Console.Out.Flush(); Console.Out.Close(); } catch { }
    Notices = null;
    // Asked by a later Combwork for its jobs as they are now (HI-2313).
    new System.Threading.Thread(Serve) { IsBackground = true }.Start();
    var last = new Dictionary<string, string>();
    while (mine.Count > 0) {
      foreach (var id in new List<string>(mine)) {
        int[] m;
        bool lost;
        if (!Look(id, out m, out lost)) { mine.Remove(id); continue; }
        if (m == null) continue;
        if (m.Length == 0) {
          // Its ancestry let go unsure: never told complete, so no "ended" (its last "live" stays, and its slot held).
          if (!lost) for (int tries = 0; tries < 3 && !WriteState(id, "ended", m); tries++) System.Threading.Thread.Sleep(200);
          lock (turn) Forget(id);
          mine.Remove(id);
          continue;
        }
        Array.Sort(m);
        string seen = string.Join(",", m);
        string before;
        if (last.TryGetValue(id, out before) && before == seen) continue;
        if (WriteState(id, "live", m)) last[id] = seen;
      }
      if (mine.Count > 0) System.Threading.Thread.Sleep(${SWEEP_MS});
    }
  }
  /** A JSON string. */
  public static string Q(string s) {
    var b = new StringBuilder("\"");
    foreach (char c in s ?? "") {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }
  /**
   * Which of the executable names (lower case, comma separated) some process on the machine runs now, as a JSON array
   * (HI-2304: whether a Windows Sandbox runs). A snapshot not read whole is an error, never "none".
   */
  public static string Running(string names) {
    var want = new HashSet<string>(names.ToLowerInvariant().Split(','));
    var found = new HashSet<string>();
    IntPtr snap = SnapshotFailsForTests() ? IntPtr.Zero : CreateToolhelp32Snapshot(2, 0);
    if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return Q("error: no snapshot");
    try {
      var e = new ProcessEntry(); e.size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
      if (!Process32FirstW(snap, ref e)) return Q("error: no snapshot");
      for (bool more = true; more; ) {
        string n = (e.exe ?? "").ToLowerInvariant();
        if (want.Contains(n)) found.Add(n);
        more = Process32NextW(snap, ref e);
      }
      if (Marshal.GetLastWin32Error() != 18) return Q("error: snapshot cut short");
    } finally { CloseHandle(snap); }
    var b = new StringBuilder("[");
    bool first = true;
    foreach (string n in found) { b.Append(first ? "" : ",").Append(Q(n)); first = false; }
    return b.Append("]").ToString();
  }
  /** The job's processes as JSON: how many, and the first max with their names and command lines. */
  /** The job's processes and the running ones it follows. */
  public static int[] Members(string id) {
    lock (turn) {
      var members = new List<int>(List(id));
      foreach (var f in followed) { uint code; if (f.Value.job == id && GetExitCodeProcess(f.Value.h, out code) && code == 259) members.Add(f.Key); }
      return members.ToArray();
    }
  }
  public static string Describe(string id, int max) {
    Sweep();
    // What joins it from here on is told again: what joined before is in this listing.
    lock (turn) Untold(id);
    int[] all = Members(id);
    int took; adopted.TryGetValue(id, out took);
    var b = new StringBuilder("{\"total\":" + all.Length + ",\"adopted\":" + took + ",\"processes\":[");
    if (all.Length > 0) {
      var where = new StringBuilder();
      for (int i = 0; i < all.Length && i < max; i++) where.Append(i > 0 ? " OR " : "").Append("ProcessId=").Append(all[i]);
      bool first = true;
      using (var q = new ManagementObjectSearcher("SELECT ProcessId, ParentProcessId, Name, CommandLine FROM Win32_Process WHERE " + where))
        foreach (ManagementObject p in q.Get()) {
          b.Append(first ? "" : ",").Append("{\"pid\":").Append(Convert.ToInt32(p["ProcessId"])).Append(",\"parent\":").Append(Convert.ToInt32(p["ParentProcessId"])).Append(",\"name\":").Append(Q((string)p["Name"])).Append(",\"cmd\":").Append(Q((string)p["CommandLine"])).Append(",\"created\":\"").Append(CreatedOf(Convert.ToInt32(p["ProcessId"]))).Append("\"}");
          first = false;
        }
    }
    return b.Append("]}").ToString();
  }
  /** The memory each job's processes use now (working sets, as Task Manager counts them), for "job,job,…": a JSON array in the same order (#562). */
  public static string Memory(string ids) {
    var b = new StringBuilder("[");
    string[] list = ids.Split(',');
    for (int i = 0; i < list.Length; i++) {
      long bytes = 0;
      foreach (int pid in Members(list[i])) {
        try { using (var p = System.Diagnostics.Process.GetProcessById(pid)) bytes += p.WorkingSet64; } catch (Exception) { }
      }
      b.Append(i > 0 ? "," : "").Append(bytes);
    }
    return b.Append("]").ToString();
  }
  /**
   * Each job's processes with their parents' state (HI-2111), for "job,job,…": JSON {"job":[{"pid","created","parent",
   * "parentCreated","cpu"}],…}, at most ${MAX_LISTED * 4} per job. parent is the id a snapshot gives; parentCreated, when
   * a process runs by that id now, its start time (a later one than the child's means the id was given again), "0" when
   * none runs by it, "?" when it can't be told (access denied). cpu: its kernel and user time, in ms. A process that
   * can't be opened, or that the snapshot hasn't, is left out. A failed snapshot: null.
   */
  public static string Lineage(string ids) {
    Sweep();
    var parents = new Dictionary<int, int>();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return "null";
    try {
      var e = new ProcessEntry(); e.size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
      if (!Process32FirstW(snap, ref e)) return "null";
      do { if (e.pid != 0) parents[(int)e.pid] = (int)e.parent; } while (Process32NextW(snap, ref e));
    } finally { CloseHandle(snap); }
    var b = new StringBuilder("{");
    string[] list = ids.Split(',');
    for (int i = 0; i < list.Length; i++) {
      b.Append(i > 0 ? "," : "").Append(Q(list[i])).Append(":[");
      int[] all = Members(list[i]);
      bool first = true;
      for (int j = 0; j < all.Length && j < ${MAX_LISTED * 4}; j++) {
        int pid = all[j], parent;
        if (!parents.TryGetValue(pid, out parent)) continue;
        IntPtr p = OpenProcess(0x1000, false, pid);
        if (p == IntPtr.Zero) continue;
        long created, x, k, u;
        bool read;
        try { read = GetProcessTimes(p, out created, out x, out k, out u); } finally { CloseHandle(p); }
        if (!read) continue;
        string pc;
        IntPtr q = parent > 0 ? OpenProcess(0x1000, false, parent) : IntPtr.Zero;
        // ERROR_INVALID_PARAMETER: no process by that id.
        if (q == IntPtr.Zero) pc = parent > 0 && Marshal.GetLastWin32Error() == 87 ? "0" : "?";
        else {
          try { uint code; long qc, qx, qk, qu; pc = !GetExitCodeProcess(q, out code) ? "?" : code != 259 ? "0" : GetProcessTimes(q, out qc, out qx, out qk, out qu) ? qc.ToString() : "?"; } finally { CloseHandle(q); }
        }
        b.Append(first ? "" : ",").Append("{\"pid\":").Append(pid).Append(",\"created\":\"").Append(created).Append("\",\"parent\":").Append(parent).Append(",\"parentCreated\":\"").Append(pc).Append("\",\"cpu\":").Append((k + u) / 10000).Append("}");
        first = false;
      }
      b.Append("]");
    }
    return b.Append("}").ToString();
  }
  /** The port and the sweeper, as Add starts them with the first job. */
  static void Started() {
    if (sweeper == null) sweeper = new System.Threading.Timer(_ => { try { Sweep(); Tell(); } catch { } }, null, ${SWEEP_MS}, ${SWEEP_MS});
    if (port == IntPtr.Zero) {
      port = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1);
      if (port != IntPtr.Zero) new System.Threading.Thread(Listen) { IsBackground = true }.Start();
    }
  }
  /**
   * A merge queue lease's job (#1360): named (QueueJobName), kill on close (closing its last handle ends every process
   * in it), no breakaway allowed; on the port, so joins are held and exits swept as agents' jobs are; what it follows is
   * written to its journal first (Journal). "ok", or why not.
   */
  public static string Open(string id, string journal) {
    Started();
    if (jobs.ContainsKey(id)) return "exists";
    IntPtr job = CreateNamedJob(IntPtr.Zero, QueueJobName(id));
    if (job == IntPtr.Zero) return "create failed: " + Marshal.GetLastWin32Error();
    if (Marshal.GetLastWin32Error() == 183) { CloseHandle(job); return "exists"; }
    var lim = new ExtLimits();
    // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    lim.basic.flags = 0x2000;
    if (!SetLimits(job, 9, ref lim, Marshal.SizeOf(typeof(ExtLimits)))) { int e = Marshal.GetLastWin32Error(); CloseHandle(job); return "limits failed: " + e; }
    jobs[id] = job;
    closing[id] = journal;
    if (port != IntPtr.Zero) {
      ulong k = nextKey++;
      var info = new PortInfo { key = new IntPtr((long)k), port = port };
      if (SetInformationJobObject(job, 7, ref info, Marshal.SizeOf(typeof(PortInfo)))) byKey[k] = id;
    }
    return "ok";
  }
  /** Unix ms of a FILETIME. */
  static long Ms(long ft) { return (ft - 116444736000000000L) / 10000; }
  /**
   * Puts a waiting launcher in job id, only while it is the process that started between two clock readings (Unix ms,
   * #1360): an id given again since names a process that started later. "ok", or why not.
   */
  public static string Assign(string id, int pid, long after, long before) {
    IntPtr job;
    if (!jobs.TryGetValue(id, out job)) return "no job";
    // PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION
    IntPtr p = OpenProcess(0x0001 | 0x0100 | 0x1000, false, pid);
    if (p == IntPtr.Zero) return "the process has gone (" + Marshal.GetLastWin32Error() + ")";
    try {
      uint code; long c, x, k, u;
      if (!GetExitCodeProcess(p, out code) || code != 259) return "the process has exited";
      if (!GetProcessTimes(p, out c, out x, out k, out u)) return "no start time";
      long at = Ms(c);
      if (at < after - 50 || at > before + 50) return "another process (started " + at + ")";
      return AssignProcessToJobObject(job, p) ? "ok" : "assign failed: " + Marshal.GetLastWin32Error();
    } finally { CloseHandle(p); }
  }
  /** Whether job id has no process, and follows none still running (after a sweep). */
  public static bool Empty(string id) {
    Sweep();
    return Members(id).Length == 0;
  }
  /**
   * Another merge queue lease's job, by its name (#1360): every process in it ended, and waited for (15 s at most) until
   * it has none. "ended"; "nojob" when there is none (closed: kill on close ended what was in it); else why not. Outside
   * the turn: it waits.
   */
  public static string EndNamed(string id) {
    // JOB_OBJECT_TERMINATE | JOB_OBJECT_QUERY
    IntPtr h = OpenNamedJob(0x0008 | 0x0004, false, QueueJobName(id));
    if (h == IntPtr.Zero) { int e = Marshal.GetLastWin32Error(); return e == 2 ? "nojob" : "open failed: " + e; }
    try {
      TerminateJobObject(h, 1);
      // JobObjectBasicAccountingInformation: ActiveProcesses, after four times and two counts.
      IntPtr buf = Marshal.AllocHGlobal(48);
      try {
        for (int i = 0; i < 150; i++) {
          if (!QueryInformationJobObject(h, 1, buf, 48, IntPtr.Zero)) return "query failed: " + Marshal.GetLastWin32Error();
          if (Marshal.ReadInt32(buf, 40) == 0) return "ended";
          System.Threading.Thread.Sleep(100);
        }
        return "busy";
      } finally { Marshal.FreeHGlobal(buf); }
    } finally { CloseHandle(h); }
  }
  /**
   * Whether a lease's job exists, by its name (HI-1723), asked with the right to query it only (JOB_OBJECT_QUERY):
   * nothing in it is touched. "exists" (some process, a supervisor, holds it), "nojob" (none by that name: nothing holds
   * it, kill on close ended what was in it), else why it can't be told (access denied, a name that isn't a job's).
   */
  public static string HasJob(string id) {
    IntPtr h = OpenNamedJob(0x0004, false, QueueJobName(id));
    if (h == IntPtr.Zero) { int e = Marshal.GetLastWin32Error(); return e == 2 ? "nojob" : "unknown: " + e; }
    CloseHandle(h);
    return "exists";
  }
  /** One request ("<n> <command> <job> [pid]") answered as "<n> <JSON>". */
  public static string Answer(string line) {
    string[] a = line.Split(' ');
    string r;
    // It waits (EndNamed): outside the turn, so the port and the sweeps go on meanwhile.
    if (a.Length > 2 && a[1] == "endnamed") {
      try { r = Q(EndNamed(a[2])); } catch (Exception e) { r = Q("error: " + e.Message); }
      return a[0] + " " + r;
    }
    try {
      lock (turn)
      switch (a.Length > 2 ? a[1] : "") {
        case "add": r = Q(Add(a[2], int.Parse(a[3]))); break;
        case "list": r = Describe(a[2], ${MAX_LISTED + 1}); break;
        case "kill": r = Kill(a[2]) ? "true" : "false"; break;
        case "forget": Forget(a[2]); r = "true"; break;
        case "identify": r = Identify(a[2]); break;
        case "endexact": r = EndExact(a[2]); break;
        case "endtree": r = EndTree(a[2]); break;
        case "memory": r = Memory(a[2]); break;
        case "running": r = Running(a[2]); break;
        case "paths": r = Paths(a[2]); break;
        case "workingin": r = WorkingIn(a[2], a.Length > 3 ? a[3] : null, ${MAX_WORKING_IN}); break;
        case "lineage": r = Lineage(a[2]); break;
        // Its journal's path, in base64url (requests are words).
        case "open": r = Q(Open(a[2], a.Length > 3 ? Encoding.UTF8.GetString(Convert.FromBase64String(a[3].Replace('-', '+').Replace('_', '/').PadRight(a[3].Length + (4 - a[3].Length % 4) % 4, '='))) : null)); break;
        case "assign": r = Q(Assign(a[2], int.Parse(a[3]), long.Parse(a[4]), long.Parse(a[5]))); break;
        case "empty": r = Empty(a[2]) ? "true" : "false"; break;
        case "hasjob": r = Q(HasJob(a[2])); break;
        // Its Combwork's identity, and the folder in base64url (HI-2055): its own identity back.
        case "keeper": r = Q(Keeper(a[2], a.Length > 3 ? Encoding.UTF8.GetString(Convert.FromBase64String(a[3].Replace('-', '+').Replace('_', '/').PadRight(a[3].Length + (4 - a[3].Length % 4) % 4, '='))) : null)); break;
        // Tests only (the host refuses to send it otherwise): follows a process, as Take does a packaged app's.
        case "follow": r = Follow(a[2], int.Parse(a[3]), 0x0001 | 0x100000) ? "true" : "false"; break;
        default: r = Q("unknown command"); break;
      }
    } catch (Exception e) { r = Q("error: " + e.Message); }
    return a[0] + " " + r;
  }
}
`

/**
 * The host's loop: one request per line ("<n> <command> <job> [pid]"), one reply per line ("<n> <JSON>"), all in the
 * C#; between them, a line "new" when a process has joined a job (Notices, #1134). No cmdlet but Add-Type, so PowerShell loads no other module (and writes no module cache, which goes into the
 * working folder when LOCALAPPDATA is unset). The C# comes first on its input, a line of base64 (HOST_INPUT): a command
 * line holds at most 32,767 characters, and -EncodedCommand doubles them and more. Its first line is its own process id
 * ("pid <n>"): it is started through a launcher (helperLaunch), so its owner's child is the launcher, not it.
 */
const HOST_SCRIPT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::Out.WriteLine('pid ' + $PID)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Management -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine())))
[CombworkJobs]::Notices = [Console]::Out
[Console]::Out.WriteLine('ready')
while ($null -ne ($line = [Console]::In.ReadLine())) { [Console]::Out.WriteLine([CombworkJobs]::Answer($line)); [CombworkJobs]::TellQueue() }
[CombworkJobs]::Keep()
`
const HOST_INPUT = Buffer.from(HOST_SOURCE, 'utf8').toString('base64') + '\n'

/**
 * The helper's launcher (HI-2314): starts the command line given with only its own standard handles (its pipes to
 * Combwork) to inherit, in a console of its own with no window, waits for it, and returns its exit code (-1: it couldn't
 * start it, said on its error output). Its fourth pipe from Hive (fd 3, the C runtime's handles in its startup info,
 * never handed on) is its control: an "e" read there ends the helper through the handle it holds (under the lock its
 * closing takes, so never once that handle is closed); the pipe's end (Combwork gone: a quit, a crash) ends nothing.
 */
const LAUNCH_SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CombworkLaunch {
  [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx {
    public int cb; public IntPtr reserved, desktop, title;
    public int x, y, xSize, ySize, xChars, yChars, fill, flags;
    public short show, reserved2Size; public IntPtr reserved2, stdIn, stdOut, stdErr;
    public IntPtr attributes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public int pid, tid; }
  [DllImport("kernel32.dll")] static extern void GetStartupInfoW(ref StartupInfoEx si);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr h, byte[] buf, int n, out int read, IntPtr overlapped);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, int code);
  static readonly object gate = new object();
  /** The helper's handle while it is held (under gate); zero once closed. */
  static IntPtr child = IntPtr.Zero;
  /** Its fd 3 from the C runtime's handles in its startup info (Node's fourth pipe), or zero. */
  static IntPtr Control() {
    var s = new StartupInfoEx();
    s.cb = Marshal.SizeOf(typeof(StartupInfoEx)) - IntPtr.Size;
    GetStartupInfoW(ref s);
    if (s.reserved2 == IntPtr.Zero || s.reserved2Size < 4) return IntPtr.Zero;
    int n = Marshal.ReadInt32(s.reserved2);
    if (n < 4 || s.reserved2Size < 4 + n + n * IntPtr.Size) return IntPtr.Zero;
    IntPtr h = Marshal.ReadIntPtr(s.reserved2, 4 + n + 3 * IntPtr.Size);
    return h == new IntPtr(-1) ? IntPtr.Zero : h;
  }
  static void Watch(object o) {
    IntPtr h = (IntPtr)o;
    var buf = new byte[64];
    int read;
    while (ReadFile(h, buf, buf.Length, out read, IntPtr.Zero) && read > 0) {
      bool end = false;
      for (int i = 0; i < read; i++) if (buf[i] == (byte)'e') end = true;
      if (end) lock (gate) if (child != IntPtr.Zero) TerminateProcess(child, 1);
    }
  }
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr h, int mask, int flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, int flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string app, StringBuilder line, IntPtr pa, IntPtr ta, bool inherit, int flags, IntPtr env, string dir, ref StartupInfoEx si, out ProcessInfo pi);
  [DllImport("kernel32.dll")] static extern int WaitForSingleObject(IntPtr h, int ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out int code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static int Run(string line) {
    IntPtr control = Control();
    // Never handed on (the handle list leaves it out too).
    if (control != IntPtr.Zero) SetHandleInformation(control, 1, 0);
    var std = new System.Collections.Generic.List<IntPtr>();
    foreach (int which in new[] { -10, -11, -12 }) {
      IntPtr h = GetStdHandle(which);
      if (h == IntPtr.Zero || h == new IntPtr(-1) || std.Contains(h)) continue;
      SetHandleInformation(h, 1, 1);
      std.Add(h);
    }
    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
    IntPtr attrs = Marshal.AllocHGlobal(size);
    IntPtr handles = Marshal.AllocHGlobal(IntPtr.Size * Math.Max(1, std.Count));
    try {
      if (!InitializeProcThreadAttributeList(attrs, 1, 0, ref size)) return Fail("attribute list");
      try {
        for (int i = 0; i < std.Count; i++) Marshal.WriteIntPtr(handles, i * IntPtr.Size, std[i]);
        // PROC_THREAD_ATTRIBUTE_HANDLE_LIST: these handles only, whatever else this process could hand down.
        if (std.Count > 0 && !UpdateProcThreadAttribute(attrs, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * std.Count), IntPtr.Zero, IntPtr.Zero)) return Fail("handle list");
        var si = new StartupInfoEx();
        si.cb = Marshal.SizeOf(typeof(StartupInfoEx));
        si.flags = 0x100;
        si.stdIn = GetStdHandle(-10); si.stdOut = GetStdHandle(-11); si.stdErr = GetStdHandle(-12);
        si.attributes = attrs;
        ProcessInfo pi;
        // EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW
        if (!CreateProcessW(null, new StringBuilder(line), IntPtr.Zero, IntPtr.Zero, std.Count > 0, 0x80000 | 0x8000000, IntPtr.Zero, null, ref si, out pi)) return Fail("start");
        CloseHandle(pi.thread);
        lock (gate) child = pi.process;
        if (control != IntPtr.Zero) new System.Threading.Thread(Watch) { IsBackground = true }.Start(control);
        WaitForSingleObject(pi.process, -1);
        int code;
        lock (gate) {
          if (!GetExitCodeProcess(pi.process, out code)) code = -1;
          CloseHandle(pi.process);
          child = IntPtr.Zero;
        }
        return code;
      } finally { DeleteProcThreadAttributeList(attrs); }
    } finally { Marshal.FreeHGlobal(attrs); Marshal.FreeHGlobal(handles); }
  }
  static int Fail(string what) {
    Console.Error.WriteLine("the helper's launcher couldn't " + what + ": " + Marshal.GetLastWin32Error());
    return -1;
  }
}
`
/** The longest command line CreateProcess takes. */
const LINE_MAX = 32767
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

/**
 * How the helper is started (HI-2314), so that it outlives its Combwork as the keeper (HI-2055): through a launcher, a
 * PowerShell of its own (LAUNCH_SOURCE). Node (libuv) puts each child it starts in one job that ends them all once Combwork
 * ends, a quit or a crash alike, and lets their own children leave it silently: the launcher is in that job and ends
 * with Combwork, the helper it starts is not. It hands the helper only its pipes to Combwork: Electron's own standard handles
 * can be inherited (a test's pipes to it, say), and a helper outliving Combwork would hold them. It waits for the helper and
 * exits with its exit code, so its owner's `exit` is the helper's; it ends the helper when told on its control pipe
 * (`stdio`'s fourth, endHelper), through the handle it holds, never by an id. Not Node's `detached`, which leaves that
 * job too: PowerShell 5.1 started without a console (DETACHED_PROCESS) exits at once, running nothing. Exported for the
 * unit tests, which start it as Combwork does and then end the Combwork.
 */
export function helperLaunch(script = HOST_SCRIPT): { file: string; args: string[]; input: string; stdio: ['pipe', 'pipe', 'pipe', 'pipe'] } {
  const line = `"${POWERSHELL}" ${psArgs(script).join(' ')}`
  const launcher = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(LAUNCH_SOURCE)}')))
exit [CombworkLaunch]::Run([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(line)}')))
`
  const args = psArgs(launcher)
  if (line.length > LINE_MAX || [POWERSHELL, ...args].join(' ').length + 8 > LINE_MAX) throw new Error('the helper’s command line is too long') // i18n-ignore: a technical error, logged (it can't happen with the scripts as they are)
  return { file: POWERSHELL, args, input: HOST_INPUT, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] }
}
function psArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] // i18n-ignore: PowerShell's arguments
}

/** Test copies' helper that is ready but never answers (CW_TEST_PROCESS_TRACKER=mute): it notes each request it reads. */
const MUTE_SCRIPT = `
$null = [Console]::In.ReadLine()
[Console]::Out.WriteLine('ready')
while ($null -ne ($line = [Console]::In.ReadLine())) { if ($env:CW_TEST_TRACKER_HEARD) { [IO.File]::AppendAllText($env:CW_TEST_TRACKER_HEARD, $line + [Environment]::NewLine) } }
`

export interface JobList {
  total: number
  /** How many of its processes the host adopted after they escaped the job (Sweep, #543). */
  adopted?: number
  processes: { pid: number; parent?: number; name: string; cmd: string; created?: string }[]
}

/**
 * The one PowerShell holding the jobs, started on first use; null once it couldn't start (nothing is tracked then).
 * What is its owner's (how long to wait, test modes, its log, what to do when it fails or stops, notices) is given.
 */
export class JobHost {
  private proc: ChildProcessWithoutNullStreams | null = null
  /** How many helpers have started (instance). */
  private helpers = 0
  private ready: Promise<boolean> | null = null
  private next = 1
  private waiting = new Map<number, (reply: unknown) => void>()
  private failed = false
  /** Closed (Combwork quitting): no helper starts again, not even for a request already on its way (a refresh's next look). */
  private closed = false
  /**
   * Every helper started that hasn't exited yet (one being replaced too), with whether it said it was ready; `gone` also
   * resolves once it says it is keeping its jobs past its Hive (HI-2055): closing waits for that, never for them to end.
   * `pid`: the helper's own id once it has said it (its "pid" line), when it was started through its launcher (helperLaunch).
   */
  private alive = new Map<ChildProcessWithoutNullStreams, { up: boolean; gone: Promise<void>; pid?: number }>()

  /** Told of each process a kill-on-close job couldn't journal and ended (onUnowned). */
  private unownedListeners = new Set<(job: string, pid: number) => void>()

  constructor(private readonly opts: JobHostOptions) {}

  /**
   * Calls fn with each process a kill-on-close job found outside it and couldn't journal (so it ended it rather than
   * follow it without a durable identity): its job and id. Returns its removal.
   */
  onUnowned(fn: (job: string, pid: number) => void): () => void {
    this.unownedListeners.add(fn)
    return () => void this.unownedListeners.delete(fn)
  }

  /** False once the host couldn't start: then nothing is tracked, and launches aren't held for it. */
  get usable(): boolean {
    return !this.failed
  }

  /** Starts the host if it isn't running: whether it runs. */
  async ensure(): Promise<boolean> {
    return !this.failed && (await this.start())
  }

  private start(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    if (this.ready) return this.ready
    // Test copies (unpackaged): CW_TEST_PROCESS_TRACKER=fail acts out a PC where PowerShell refuses the helper.
    if (this.opts.testMode() === 'fail') {
      this.opts.onFailed({ kind: 'test' })
      this.failed = true
      return Promise.resolve(false)
    }
    this.ready = new Promise<boolean>((resolve) => {
      let up = false
      let p: ChildProcessWithoutNullStreams
      let direct = false
      try {
        // Test copies: CW_TEST_PROCESS_TRACKER=silent acts out a helper that starts but never says it is ready, =mute
        // one that is ready but never answers (each request it reads noted in CW_TEST_TRACKER_HEARD), until its input closes.
        // The test modes' PowerShell is Combwork's own child (no keeper: ended with Combwork, the silent one included); the
        // helper is started through its launcher, to outlive Hive (helperLaunch).
        const mode = this.opts.testMode()
        direct = mode === 'silent' || mode === 'mute'
        const { file, args, stdio } = direct ? { file: POWERSHELL, args: psArgs(mode === 'silent' ? '[System.Threading.Thread]::Sleep(-1)' : MUTE_SCRIPT), stdio: 'pipe' as const } : helperLaunch()
        // In the temp folder: nothing it might write lands in whatever folder Combwork was started from.
        p = this.opts.launch ? this.opts.launch(file, args) : (spawn(file, args, { windowsHide: true, stdio, cwd: tmpdir() }) as ChildProcessWithoutNullStreams)
      } catch (e) {
        this.opts.log.warn('could not start the process job host: agents\u2019 leftover processes are not tracked', e)
        this.opts.onFailed({ kind: 'noPowerShell', error: (e as Error).message })
        this.failed = true
        return resolve(false)
      }
      this.proc = p
      this.helpers++
      let keeping = (): void => undefined
      const state: { up: boolean; gone: Promise<void>; pid?: number } = {
        up: false,
        gone: new Promise<void>((r) => {
          keeping = r
          p.once('exit', () => r())
        }),
        // Started directly (a test mode): its id is its child's.
        ...(direct && p.pid !== undefined ? { pid: p.pid } : {})
      }
      // A helper that never started (no pid) has nothing to wait for.
      if (p.pid === undefined) state.gone = Promise.resolve()
      this.alive.set(p, state)
      void state.gone.then(() => this.alive.delete(p))
      p.stdin.write(HOST_INPUT)
      // A helper that doesn't say it is ready in time is taken for broken, for the rest of this run: launches go on
      // untracked (decision B), rather than waiting for it.
      const readyBy = setTimeout(() => {
        if (up || this.proc !== p) return
        this.proc = null
        this.ready = null
        this.endHelper(p)
        this.opts.log.warn(`the process job host didn't start within ${Math.round(this.opts.waitMs() / 1000)} s: agents\u2019 leftover processes are not tracked`)
        this.opts.onFailed({ kind: 'slowHelper', seconds: Math.round(this.opts.waitMs() / 1000) })
        this.failed = true
        resolve(false)
      }, this.opts.waitMs())
      let buf = ''
      let err = ''
      p.stdout.setEncoding('utf8')
      p.stderr.setEncoding('utf8')
      p.stderr.on('data', (d: string) => (err = (err + d).slice(-2000)))
      p.stdout.on('data', (d: string) => {
        buf += d
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          const own = !up && state.pid === undefined ? /^pid (\d+)$/.exec(line) : null
          if (own) {
            state.pid = Number(own[1])
            continue
          }
          if (!up && line === 'ready') {
            up = state.up = true
            clearTimeout(readyBy)
            resolve(true)
            continue
          }
          if (line === 'new') {
            this.opts.onJoined()
            continue
          }
          // Its input ended (closing), and it stays for its agents' jobs (HI-2055): it answers nothing more.
          if (line === 'keeping') {
            keeping()
            continue
          }
          // A process a kill-on-close job (a merge queue's) couldn't journal, and ended at once: its owner pauses.
          const unowned = /^unowned (\S+) (\d+)$/.exec(line)
          if (unowned) {
            for (const fn of this.unownedListeners) fn(unowned[1], Number(unowned[2]))
            continue
          }
          const sp = line.indexOf(' ')
          const n = Number(line.slice(0, sp))
          const done = this.waiting.get(n)
          if (!done) continue
          this.waiting.delete(n)
          try {
            done(JSON.parse(line.slice(sp + 1)))
          } catch {
            done(null)
          }
        }
      })
      const ended = (why: string): void => {
        clearTimeout(readyBy)
        if (this.proc !== p) {
          // Closed before it was ready: nothing waits for it to start any more.
          if (!up) resolve(false)
          return
        }
        this.proc = null
        this.ready = null
        for (const done of this.waiting.values()) done(null)
        this.waiting.clear()
        if (!up) {
          this.opts.log.warn(`the process job host didn't start (${why}): agents\u2019 leftover processes are not tracked. ${err.trim().slice(0, 300)}`)
          this.opts.onFailed(/language mode|ConstrainedLanguage|Add-Type/i.test(err) ? { kind: 'refused' } : { kind: 'helperFailed', why })
          this.failed = true
          resolve(false)
        } else {
          // Its jobs went with it: what they held is no longer tracked (and keeps running).
          this.opts.log.warn(`the process job host ended (${why})`)
          this.opts.onLost(why)
        }
      }
      p.on('error', (e) => ended(e.message))
      p.on('exit', (code) => ended(`exit ${code}`)) // i18n-ignore: how the helper ended, a technical detail kept as it came (the log, Diagnostics)
      p.stdin.on('error', () => undefined)
    })
    return this.ready
  }

  /**
   * One request's reply (null: no host, or none). Starting the host is bounded by its own wait (start); once it runs,
   * a reply that doesn't come within its wait (waitMs) means it is stuck: it is closed, its jobs lost (jobsLost), and the next
   * request starts a new one. So nothing (a launch, End, quitting) waits on it for longer.
   */
  async request(command: HostCommand, job: string, ...args: (number | string | undefined)[]): Promise<unknown> {
    // A job's id, or (identify, endexact) a list of processes by id and start time: "pid:created,…", or (memory) of jobs:
    // "job,job,…", or (running, HI-2304) of executables' names: "name.exe,name.exe" (words, dots and hyphens, no spaces).
    // workingin (HI-2467): names as running's, and its test stand-ins ("n-n-…") only for a host that allows test requests.
    const word = command === 'running' || command === 'workingin' ? /^[\w.-]+(,[\w.-]+)*$/ : /^[\w:,-]+$/
    if (this.failed || !word.test(job) || (command === 'follow' && !this.opts.testRequests)) return null
    if (command === 'workingin' && args.some((a) => a !== undefined) && (!this.opts.testRequests || !args.every((a) => a === undefined || (typeof a === 'string' && /^\d+(-\d+)*$/.test(a))))) return null
    if (!(await this.start()) || !this.proc) return null
    const p = this.proc
    const n = this.next++
    let timer: ReturnType<typeof setTimeout> | undefined
    const reply = new Promise<unknown>((resolve) => {
      this.waiting.set(n, resolve)
      timer = setTimeout(() => {
        if (!this.waiting.delete(n)) return
        resolve(null)
        this.opts.log.warn(`the process job host didn't answer within ${Math.round(this.opts.waitMs() / 1000)} s (${command}): closing it`)
        if (this.proc === p) this.endHelper(p)
      }, this.opts.waitMs())
    })
    // Numbers, and words (a path goes as base64url): nothing that could split a request.
    const extra = args.filter((a): a is number | string => (typeof a === 'number' ? !!a && Number.isSafeInteger(a) : typeof a === 'string' && /^[\w-]+$/.test(a)))
    p.stdin.write(`${n} ${command} ${job}${extra.map((a) => ` ${a}`).join('')}\n`)
    try {
      return await reply
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * The helper's process id while it runs (tests: to end it as a crash would): its own, so null for the moment after it
   * starts before it has said it (never its launcher's).
   */
  get pid(): number | null {
    return this.proc ? (this.alive.get(this.proc)?.pid ?? null) : null
  }

  /**
   * Ends a helper (stuck, or not ready when closing), never by an id (#603): its launcher is told on its control pipe and
   * ends it through the handle it holds, then exits (its `exit`); its input is closed. One started without a launcher (a
   * test mode), or with no control pipe, is ended as Combwork's own child. A launcher that hasn't exited within the wait
   * (stuck itself) is ended, and its helper then sees its input end.
   */
  private endHelper(p: ChildProcessWithoutNullStreams): void {
    const control = p.stdio[3] as Writable | null | undefined
    try {
      p.stdin.destroy()
    } catch {
      // Gone already.
    }
    if (!control?.writable) {
      p.kill()
      return
    }
    control.on('error', () => undefined)
    control.write('e')
    if (p.exitCode !== null || p.signalCode !== null) return
    const bound = setTimeout(() => p.kill(), this.opts.waitMs())
    p.once('exit', () => clearTimeout(bound))
  }

  /**
   * Which helper runs now (HI-1757): a number that goes up each time one starts, so never the same for two helpers (a
   * pid can be reused); null while none runs. A job this host made is this helper's only while it is unchanged.
   */
  get instance(): number | null {
    return this.proc ? this.helpers : null
  }

  /**
   * Closes the host (Combwork quitting): its jobs close without ending anything. A helper that hasn't said it is ready holds
   * no jobs, and may never read its input: it is ended. No helper starts after this. Resolves once every helper started
   * has exited, so nothing of theirs (their working folder, the temp folder) is held any more (#1020).
   */
  close(): Promise<void> {
    this.closed = true
    const p = this.proc
    this.proc = null
    this.ready = null
    try {
      p?.stdin.end()
    } catch {
      // Already gone.
    }
    // Requests on their way get no answer: said now, not once they time out (a refresh's next look would follow).
    for (const done of this.waiting.values()) done(null)
    this.waiting.clear()
    for (const [q, { up }] of this.alive) if (!up) this.endHelper(q)
    return Promise.all([...this.alive.values()].map((h) => h.gone)).then(() => undefined)
  }
}

