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
  baseline: 133,
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
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

/**
 * OpenCode's event stream, carried to Combwork's hook server (HI-2760, design s7 to s22). It decides nothing: it projects
 * the events Combwork follows (the types it subscribes to, its session's only, text cut), takes settled snapshots (one
 * durable watermark before and after their reads), and posts them in order, each with its generation. On a reconnect, an
 * overflow, a failed post, an over-long frame or a failed read it holds what comes, takes a settled snapshot again, and
 * posts it, then what it held beyond its watermark. Every read and post is bounded in time and bytes.
 */
public static class CwStream {
  public static string Url, Auth, Session, HookUrl, HookToken, Intent;
  /** A test's relay for the event stream alone (CW_OC_STREAM_VIA, to force a disconnect); Combwork never sets it. */
  public static string StreamVia = "";
  static readonly string[] Types = { "session.inbox.enqueued", "session.step.started", "session.tool.called", "session.tool.success", "session.tool.failed", "permission.asked", "permission.replied", "session.retry.scheduled", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.compaction.started", "session.compaction.ended", "session.usage.updated" };
  const int FrameMax = 262144, PageBytes = 1048576, BodyMax = 65536, QueueItems = 512, PageLimit = 50, Pages = 10;
  const long QueueBytes = 1048576;
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4 * 1048576 };
  static readonly object gate = new object();
  /** Bodies to post, in order, each with the user messages Combwork knows once it takes it. */
  static readonly Queue<KeyValuePair<string, string[]>> queue = new Queue<KeyValuePair<string, string[]>>();
  static long queueBytes;
  /** Held while a snapshot is taken (null: not holding): each projected event with its durable seq (-1: none). */
  static List<KeyValuePair<long, Dictionary<string, object>>> held = new List<KeyValuePair<long, Dictionary<string, object>>>();
  static long heldBytes;
  static int gen;
  static volatile bool connected, resync = true, stopping;
  static readonly AutoResetEvent kick = new AutoResetEvent(false), posted = new AutoResetEvent(false);
  static readonly HashSet<string> known = new HashSet<string>();
  static string baselineIdle;
  public static volatile string LastProblem = "";
  /** The launch is over (its owner gone): startup stops waiting. */
  public static Func<bool> Abandoned = () => false;

  static object G(object o, string k) { var d = o as Dictionary<string, object>; object v; return d != null && d.TryGetValue(k, out v) ? v : null; }
  static string S(object o, int max) { var s = o as string; return s == null ? null : (s.Length > max ? s.Substring(0, max) : s); }
  static void Put(Dictionary<string, object> d, string k, object v) { if (v != null) d[k] = v; }

  /** An event projected as Combwork's projectEvent does (events.ts): null when it isn't one Combwork follows. */
  public static Dictionary<string, object> Project(object raw, out long seq) {
    seq = -1;
    string type = G(raw, "type") as string;
    object d = G(raw, "data");
    if (type == null || Array.IndexOf(Types, type) < 0 || (G(d, "sessionID") as string) != Session) return null;
    var e = new Dictionary<string, object>();
    e["type"] = type;
    object dur = G(raw, "durable");
    if (dur != null && G(dur, "seq") != null) { seq = Convert.ToInt64(G(dur, "seq")); e["seq"] = seq; }
    if (type == "session.inbox.enqueued") { Put(e, "inboxID", G(d, "inboxID") as string); Put(e, "itemType", G(G(d, "item"), "type") as string); Put(e, "text", S(G(G(G(d, "item"), "payload"), "text"), 2000)); }
    if (type == "session.step.started" || type == "session.retry.scheduled") Put(e, "assistantMessageID", G(d, "assistantMessageID") as string);
    if (type.StartsWith("session.tool.")) { Put(e, "callID", G(d, "id") as string); Put(e, "toolName", S(G(d, "name"), 200)); }
    if (type == "permission.asked") {
      Put(e, "requestID", G(d, "id") as string); Put(e, "messageID", G(G(d, "source"), "messageID") as string); Put(e, "callID", G(G(d, "source"), "id") as string); Put(e, "action", S(G(d, "action"), 200));
      var res = G(d, "resources") as object[];
      if (res != null) { var parts = new List<string>(); foreach (object r in res) if (r is string) parts.Add((string)r); Put(e, "resources", S(string.Join(" ", parts.ToArray()), 500)); }
    }
    if (type == "permission.replied") { Put(e, "requestID", G(d, "requestID") as string); Put(e, "reply", G(d, "reply") as string); }
    object err = G(d, "error");
    if (err != null) { var x = new Dictionary<string, object>(); Put(x, "type", S(G(err, "type"), 200)); Put(x, "message", S(G(err, "message"), 500)); if (G(err, "status") is int) x["status"] = G(err, "status"); e["error"] = x; }
    Put(e, "reason", S(G(d, "reason"), 200));
    if (type == "session.usage.updated") {
      Put(e, "cost", Num(G(d, "cost")));
      object k = G(d, "tokens"), c = G(k, "cache");
      var cache = new Dictionary<string, object>(); Put(cache, "read", Num(G(c, "read"))); Put(cache, "write", Num(G(c, "write")));
      var tok = new Dictionary<string, object>(); Put(tok, "input", Num(G(k, "input"))); Put(tok, "output", Num(G(k, "output"))); Put(tok, "reasoning", Num(G(k, "reasoning"))); tok["cache"] = cache;
      e["tokens"] = tok;
    }
    return e;
  }
  /** A number as JSON gives one (int, long, decimal or double), else null. */
  static object Num(object v) { return v is int || v is long || v is decimal || v is double ? v : null; }

  /** A GET of the server's: its status (0: none; -2: over cap bytes, not read further) and text. */
  static int Get(string path, int cap, out string text) {
    text = "";
    try {
      var r = (HttpWebRequest)WebRequest.Create(Url + path);
      r.Method = "GET"; r.Timeout = 5000; r.ReadWriteTimeout = 5000; r.Proxy = null; r.Headers["Authorization"] = Auth;
      using (var resp = (HttpWebResponse)r.GetResponse()) return ReadCapped(resp, cap, out text);
    } catch (WebException e) {
      var resp = e.Response as HttpWebResponse;
      if (resp == null) return 0;
      try { ReadCapped(resp, cap, out text); } catch (Exception) { }
      return (int)resp.StatusCode;
    } catch (Exception) { return 0; }
  }
  static int ReadCapped(HttpWebResponse resp, int cap, out string text) {
    using (var s = resp.GetResponseStream()) using (var m = new MemoryStream()) {
      var buf = new byte[16384]; int n;
      while ((n = s.Read(buf, 0, buf.Length)) > 0) { m.Write(buf, 0, n); if (m.Length > cap) { text = ""; return -2; } }
      text = Encoding.UTF8.GetString(m.ToArray());
      return (int)resp.StatusCode;
    }
  }

  /** Posts one body to Combwork's hook server; whether it took it. */
  static bool Post(string body) {
    try {
      var r = (HttpWebRequest)WebRequest.Create(HookUrl);
      r.Method = "POST"; r.Timeout = 5000; r.ReadWriteTimeout = 5000; r.Proxy = null; r.ContentType = "application/json";
      r.Headers["Authorization"] = "Bearer " + HookToken;
      byte[] data = Encoding.UTF8.GetBytes(body);
      r.ContentLength = data.Length;
      using (var s = r.GetRequestStream()) s.Write(data, 0, data.Length);
      using (var resp = (HttpWebResponse)r.GetResponse()) return (int)resp.StatusCode >= 200 && (int)resp.StatusCode < 300;
    } catch (Exception) { return false; }
  }

  static string EventBody(Dictionary<string, object> e, int g) { return Json.Serialize(new Dictionary<string, object> { { "hook_event_name", "OpencodeEvent" }, { "session_id", Session }, { "gen", g }, { "event", e } }); }

  /** The session's durable watermark (the log's log.synced seq), or -1. */
  static long Watermark() {
    string t;
    if (Get("/api/experimental/session/" + Uri.EscapeDataString(Session) + "/log?after=0", 65536, out t) != 200) return -1;
    var m = Regex.Match(t, "\"type\"\\s*:\\s*\"log\\.synced\"[^}]*\"seq\"\\s*:\\s*(\\d+)");
    return m.Success ? long.Parse(m.Groups[1].Value) : -1;
  }

  /** One message projected (oldest first is the caller's): its id, type, outcome, error, a user message's text cut. */
  static Dictionary<string, object> ProjectMessage(object m) {
    var p = new Dictionary<string, object>();
    Put(p, "id", G(m, "id") as string); Put(p, "type", G(m, "type") as string); Put(p, "outcome", G(m, "outcome") as string);
    object err = G(m, "error");
    if (err != null) { var x = new Dictionary<string, object>(); Put(x, "type", S(G(err, "type"), 200)); Put(x, "message", S(G(err, "message"), 500)); p["error"] = x; }
    if ((G(m, "type") as string) == "user") Put(p, "text", S(G(m, "text"), 200));
    if ((G(m, "type") as string) == "compaction") { Put(p, "status", S(G(m, "status"), 50)); Put(p, "reason", S(G(m, "reason"), 200)); }
    return p;
  }

  /**
   * A snapshot, settled or not: the watermark, the session, its pending permissions, its messages back to a boundary,
   * the watermark again. Null when a read failed. settled when nothing durable happened during the reads.
   */
  static Dictionary<string, object> Snapshot(bool baseline, out bool settled, out long w) {
    settled = false; w = -1;
    long w1 = Watermark();
    if (w1 < 0) { LastProblem = "the log's watermark couldn't be read"; return null; }
    string t;
    if (Get("/api/session/" + Uri.EscapeDataString(Session), PageBytes, out t) != 200) { LastProblem = "the session couldn't be read"; return null; }
    object info = G(Json.DeserializeObject(t), "data");
    var session = new Dictionary<string, object>();
    object time = G(info, "time");
    Put(session, "busy", G(time, "busy")); Put(session, "idle", G(time, "idle")); Put(session, "outcome", G(info, "outcome") as string);
    if (Get("/api/session/" + Uri.EscapeDataString(Session) + "/permission", PageBytes, out t) != 200) { LastProblem = "the permissions couldn't be read"; return null; }
    var permissions = new List<object>();
    var plist = G(Json.DeserializeObject(t), "data") as object[];
    if (plist != null) foreach (object p in plist) {
      if (permissions.Count >= 20) break;
      var q = new Dictionary<string, object>();
      Put(q, "id", G(p, "id") as string); Put(q, "action", S(G(p, "action"), 200)); Put(q, "messageID", G(G(p, "source"), "messageID") as string); Put(q, "callID", G(G(p, "source"), "id") as string);
      var res = G(p, "resources") as object[];
      if (res != null) { var parts = new List<string>(); foreach (object r in res) if (r is string) parts.Add((string)r); Put(q, "resources", S(string.Join(" ", parts.ToArray()), 500)); }
      permissions.Add(q);
    }
    // The messages, newest first, back to a user message already known, the baseline's idle marker, or the start.
    var newestFirst = new List<Dictionary<string, object>>();
    HashSet<string> knownNow;
    lock (gate) knownNow = new HashSet<string>(known);
    string boundary = "partial", cursor = null;
    int limit = PageLimit;
    for (int page = 0; page < Pages; ) {
      string q = "/api/session/" + Uri.EscapeDataString(Session) + "/message?limit=" + limit + (cursor == null ? "&order=desc" : "&cursor=" + Uri.EscapeDataString(cursor));
      int st = Get(q, PageBytes, out t);
      if (st == -2) { if (limit == 1) { LastProblem = "a message over the size bound"; break; } limit = Math.Max(1, limit / 2); continue; }
      if (st != 200) { LastProblem = "the messages couldn't be read (HTTP " + st + ")"; return null; }
      object reply = Json.DeserializeObject(t);
      var data = G(reply, "data") as object[] ?? new object[0];
      bool stop = false;
      foreach (object m in data) {
        string id = G(m, "id") as string, type = G(m, "type") as string;
        if ((type == "user" && id != null && knownNow.Contains(id)) || (baselineIdle != null && id == baselineIdle)) { stop = true; boundary = "known"; break; }
        newestFirst.Add(ProjectMessage(m));
      }
      if (stop) break;
      cursor = G(G(reply, "cursor"), "next") as string;
      if (data.Length == 0 || cursor == null) { boundary = "start"; break; }
      page++;
      limit = PageLimit;
    }
    long w2 = Watermark();
    if (w2 < 0) { LastProblem = "the log's watermark couldn't be read"; return null; }
    settled = w1 == w2;
    w = w2;
    newestFirst.Reverse();
    var snap = new Dictionary<string, object> { { "w", w2 }, { "session", session }, { "permissions", permissions }, { "messages", newestFirst }, { "boundary", boundary } };
    if (baseline) { snap["baseline"] = true; snap["intent"] = Intent; }
    // Within the body's bound: the oldest messages go first (and the boundary is then partial).
    while (newestFirst.Count > 0 && Json.Serialize(snap).Length > BodyMax - 512) { newestFirst.RemoveAt(0); snap["boundary"] = "partial"; }
    return snap;
  }

  /** A snapshot's user messages: Combwork knows them once it has taken the snapshot (never before: a refused post). */
  static string[] UsersOf(Dictionary<string, object> snap) {
    var users = new List<string>();
    foreach (var m in snap["messages"] as List<Dictionary<string, object>>) if ((m.ContainsKey("type") ? m["type"] as string : null) == "user" && m.ContainsKey("id")) users.Add((string)m["id"]);
    return users.ToArray();
  }

  /** A resumed session's baseline marker: its newest idle message, which paging stops at from then on. */
  static void Baseline(Dictionary<string, object> snap, bool baseline) {
    var msgs = snap["messages"] as List<Dictionary<string, object>>;
    if (baseline && Intent == "resume") for (int i = msgs.Count - 1; i >= 0; i--) if ((msgs[i].ContainsKey("type") ? msgs[i]["type"] as string : null) == "idle") { baselineIdle = msgs[i]["id"] as string; break; }
  }

  /** Takes snapshots until one is settled or until passes: its body, posted with what was held beyond its watermark. */
  static bool Settle(bool baseline, DateTime until, bool postNow) {
    int wait = 200;
    while (!stopping && DateTime.UtcNow < until && !Abandoned()) {
      bool settled; long w;
      var snap = Snapshot(baseline, out settled, out w);
      if (snap != null && settled) {
        lock (gate) {
          gen++;
          string body = Json.Serialize(new Dictionary<string, object> { { "hook_event_name", "OpencodeSnapshot" }, { "session_id", Session }, { "gen", gen }, { "snapshot", snap } });
          if (postNow) {
            if (!Post(body)) { LastProblem = "Combwork's hook server didn't take the first snapshot"; return false; }
            foreach (string u in UsersOf(snap)) known.Add(u);
          } else { queue.Clear(); queueBytes = 0; Enqueue(body, UsersOf(snap)); }
          Baseline(snap, baseline);
          foreach (var kv in held) if (kv.Key < 0 || kv.Key > w) Enqueue(EventBody(kv.Value, gen), UserOf(kv.Value));
          held = null; heldBytes = 0;
        }
        posted.Set();
        return true;
      }
      if (snap != null) LastProblem = "the session kept changing while it was read";
      Thread.Sleep(wait);
      wait = Math.Min(wait * 2, 5000);
    }
    return false;
  }

  /** The submission an event is, if it is one: Combwork knows it once it has taken the event. */
  static string[] UserOf(Dictionary<string, object> e) {
    return (e["type"] as string) == "session.inbox.enqueued" && e.ContainsKey("inboxID") ? new[] { (string)e["inboxID"] } : new string[0];
  }

  /** Into the post queue (under gate); over its bounds, everything queued goes and a resync follows. */
  static void Enqueue(string body, string[] users) {
    if (body.Length > BodyMax) { Resync(); return; }
    if (queue.Count >= QueueItems || queueBytes + body.Length > QueueBytes) { Resync(); return; }
    queue.Enqueue(new KeyValuePair<string, string[]>(body, users)); queueBytes += body.Length;
    Monitor.PulseAll(gate);
  }

  /** Drops what is queued and held, and holds from now until a settled snapshot is posted (under gate or not). */
  public static void Resync() {
    lock (gate) {
      queue.Clear(); queueBytes = 0;
      held = new List<KeyValuePair<long, Dictionary<string, object>>>(); heldBytes = 0;
      resync = true;
    }
    kick.Set();
  }

  static void Take(string data) {
    object raw;
    try { raw = Json.DeserializeObject(data); } catch (Exception) { return; }
    if ((G(raw, "type") as string) == "server.connected") { connected = true; kick.Set(); return; }
    long seq;
    var e = Project(raw, out seq);
    if (e == null) return;
    lock (gate) {
      if (held != null) {
        long size = Json.Serialize(e).Length;
        if (held.Count >= QueueItems || heldBytes + size > QueueBytes) { held.Clear(); heldBytes = 0; resync = true; kick.Set(); return; }
        held.Add(new KeyValuePair<long, Dictionary<string, object>>(seq, e)); heldBytes += size;
        return;
      }
      Enqueue(EventBody(e, gen), UserOf(e));
    }
  }

  /** The stream: reconnected with backoff; each connect holds what comes until a settled snapshot is posted. */
  static void Reader() {
    int wait = 200;
    var q = new StringBuilder("/api/event?");
    for (int i = 0; i < Types.Length; i++) q.Append(i > 0 ? "&" : "").Append("types=").Append(Uri.EscapeDataString(Types[i]));
    while (!stopping) {
      try {
        lock (gate) { if (held == null) { held = new List<KeyValuePair<long, Dictionary<string, object>>>(); heldBytes = 0; } resync = true; }
        var r = (HttpWebRequest)WebRequest.Create((StreamVia != "" ? StreamVia : Url) + q.ToString());
        r.Method = "GET"; r.Timeout = 10000; r.ReadWriteTimeout = 30000; r.Proxy = null; r.Headers["Authorization"] = Auth; r.KeepAlive = true;
        using (var resp = (HttpWebResponse)r.GetResponse()) using (var s = resp.GetResponseStream()) {
          var line = new StringBuilder();
          bool over = false;
          var buf = new byte[8192]; int n;
          var dec = Encoding.UTF8.GetDecoder();
          var chars = new char[8192];
          while (!stopping && (n = s.Read(buf, 0, buf.Length)) > 0) {
            wait = 200;
            int c = dec.GetChars(buf, 0, n, chars, 0);
            for (int i = 0; i < c; i++) {
              char ch = chars[i];
              if (ch == '\n') {
                if (over) Resync(); else if (line.Length > 6 && line.ToString(0, 6) == "data: ") Take(line.ToString(6, line.Length - 6));
                line.Length = 0; over = false;
              } else if (ch != '\r') { if (line.Length < FrameMax) line.Append(ch); else over = true; }
            }
          }
        }
      } catch (Exception) { }
      connected = false;
      if (stopping) return;
      Thread.Sleep(wait);
      wait = Math.Min(wait * 2, 2000);
    }
  }

  /** Posts the queue in order; a failed post drops it and resyncs. */
  static void Poster() {
    while (!stopping) {
      KeyValuePair<string, string[]> item;
      lock (gate) {
        while (queue.Count == 0 && !stopping) Monitor.Wait(gate, 1000);
        if (stopping) return;
        item = queue.Dequeue(); queueBytes -= item.Key.Length;
      }
      if (!Post(item.Key)) { LastProblem = "Combwork's hook server didn't take an event"; Resync(); continue; }
      lock (gate) foreach (string u in item.Value) known.Add(u);
    }
  }

  /** Resyncs whenever asked: a reconnect, an overflow, a failed post, a failed read. */
  static void Repairer() {
    while (!stopping) {
      kick.WaitOne(1000);
      if (stopping) return;
      if (resync && connected) { resync = false; if (!Settle(false, DateTime.MaxValue, false)) resync = true; }
    }
  }

  /**
   * Before the TUI starts (design s22): subscribed, then a settled baseline posted, within until; whether it was. Then
   * the poster and the repairer run until the launcher ends.
   */
  public static bool Start(DateTime until) {
    var reader = new Thread(Reader) { IsBackground = true }; reader.Start();
    while (!connected && DateTime.UtcNow < until && !Abandoned()) Thread.Sleep(50);
    if (!connected) { LastProblem = "the server's event stream didn't connect"; return false; }
    resync = false;
    if (!Settle(true, until, true)) return false;
    new Thread(Poster) { IsBackground = true }.Start();
    new Thread(Repairer) { IsBackground = true }.Start();
    return true;
  }

  public static void Stop() { stopping = true; kick.Set(); lock (gate) Monitor.PulseAll(gate); }
}

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
  /** The server's log, where what the launcher says goes too (its terminal may be gone by then). */
  static string sayLog;
  static void Say(string s) {
    try { Console.Error.WriteLine("Combwork: " + s); } catch (Exception) { }
    // Shared as the server's log is (it is open for its output meanwhile).
    try { if (sayLog != null) using (var f = new FileStream(sayLog, FileMode.Append, FileAccess.Write, FileShare.ReadWrite)) { byte[] b = Encoding.UTF8.GetBytes("[Combwork launcher] " + s + "\r\n"); f.Write(b, 0, b.Length); } } catch (Exception) { }
  }

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

  /**
   * One argument of the line cmd.exe runs, as Combwork's own cmdArg (common.ts, HI-2722) quotes it: quoted when it is empty
   * or has a space, a quote or a character cmd.exe acts on, so &|<>^ stay inside cmd.exe's quotes; a quote doubled; a %
   * followed by %cd:~,% (expanded to nothing), so no %NAME% in it expands; backslashes before a quote doubled.
   */
  static string CmdArg(string arg) {
    if (arg.Length > 0 && !Regex.IsMatch(arg, "[\\s\"&|<>^(),;=%!]")) return arg;
    var b = new StringBuilder("\"");
    int slashes = 0;
    foreach (char ch in arg) {
      if (ch == '\\') { slashes++; continue; }
      if (ch == '"') { b.Append('\\', slashes * 2).Append("\"\""); slashes = 0; continue; }
      if (ch == '%') { b.Append('\\', slashes).Append("%%cd:~,%"); slashes = 0; continue; }
      b.Append('\\', slashes).Append(ch); slashes = 0;
    }
    return b.Append('\\', slashes * 2).Append('"').ToString();
  }

  /** What to run for opencode: the executable and the arguments before its own (a Node launcher's script, toSpawnable). */
  static string exe0; static List<string> prefix = new List<string>();

  /**
   * opencode started with these arguments: an .exe (or a Node launcher's node and script) by Windows' argv rules; a .cmd
   * or .bat through cmd.exe, /d /s /c "<each CmdArg>", as Combwork starts one (toSpawnable).
   */
  static ProcessStartInfo Start(List<string> args) {
    var all = new List<string>(prefix); all.AddRange(args);
    string ext = Path.GetExtension(exe0).ToLowerInvariant();
    ProcessStartInfo s;
    if (ext == ".cmd" || ext == ".bat") {
      var parts = new List<string>(); parts.Add(CmdArg(exe0)); foreach (var a in all) parts.Add(CmdArg(a));
      s = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe"), "/d /s /c \"" + string.Join(" ", parts.ToArray()) + "\"");
    } else s = new ProcessStartInfo(exe0, Line(all));
    s.UseShellExecute = false;
    return s;
  }

  /** The owner's handle (null: none, a test); gone: the launch stops wherever it is, before anything more is done. */
  static WaitHandle ownerWait;
  static bool OwnerGone() { return ownerWait != null && ownerWait.WaitOne(0); }

  /** A wait handle that is set when the process ends (its own handle, not owned). */
  static WaitHandle Exits(Process p) { return new ManualResetEvent(false) { SafeWaitHandle = new SafeWaitHandle(p.Handle, false) }; }

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
    string exe = E("CW_OC_EXE"), cwd = E("CW_OC_CWD"), session = E("CW_OC_SESSION"), intent = E("CW_OC_INTENT"), info = E("CW_OC_INFO"), log = E("CW_OC_LOG"), owner = E("CW_OC_OWNER"), marks = E("CW_OC_MARKS"), hookUrl = E("CW_OC_HOOK_URL"), streamVia = E("CW_OC_STREAM_VIA");
    string pw = E("OPENCODE_PASSWORD");
    int readyMs; if (!int.TryParse(E("CW_OC_READY_MS"), out readyMs) || readyMs < 1000) readyMs = 30000;
    long logMax; if (!long.TryParse(E("CW_OC_LOG_MAX"), out logMax) || logMax < 4096) logMax = 1048576;
    exe0 = exe; sayLog = log == "" ? null : log;
    foreach (string a in E("CW_OC_PREFIX").Split('\u001f')) if (a.Length > 0) prefix.Add(a);
    var tuiArgs = new List<string>(); foreach (string a in E("CW_OC_TUI_ARGS").Split('\u001f')) if (a.Length > 0) tuiArgs.Add(a);
    var dirs = new List<string>(); foreach (string d in E("CW_OC_DIRS").Split('\u001f')) if (d.Length > 0) dirs.Add(Norm(d));
    foreach (string n in new string[] { "CW_OC_STREAM_VIA", "CW_OC_HOOK_URL", "CW_OC_PREFIX", "CW_OC_MARKS", "CW_OC_EXE", "CW_OC_CWD", "CW_OC_SESSION", "CW_OC_INTENT", "CW_OC_INFO", "CW_OC_LOG", "CW_OC_OWNER", "CW_OC_READY_MS", "CW_OC_LOG_MAX", "CW_OC_TUI_ARGS", "CW_OC_DIRS", "CW_OC_CS" }) Environment.SetEnvironmentVariable(n, null);
    if (exe == "" || cwd == "" || pw == "" || info == "" || log == "" || marks == "" || !session.StartsWith("ses") || (intent != "new" && intent != "resume")) { Say("the launch was given incomplete settings."); return ${LAUNCHER_EXIT.input}; }

    string why;
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
      if (OwnerGone()) { Say("Combwork ended: OpenCode isn't started."); return ${LAUNCHER_EXIT.ownerEnded}; }
      var s = Start(new List<string> { "serve", "--hostname", "127.0.0.1", "--port", port.ToString() });
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
        // The server ending, or the owner: whichever comes first in the next 200 ms.
        var w = ownerWait == null ? new WaitHandle[] { Exits(serve) } : new WaitHandle[] { Exits(serve), ownerWait };
        int hit = WaitHandle.WaitAny(w, 200);
        if (hit == 1) { Say("Combwork ended while OpenCode's server was starting."); return ${LAUNCHER_EXIT.ownerEnded}; }
        if (hit == 0) break;
      }
      if (url == null && !serve.HasExited) { Say("OpenCode's server didn't answer within " + (readyMs / 1000) + " s."); return ${LAUNCHER_EXIT.serverStart}; }
    }
    if (url == null) { Say("OpenCode's server ended as it started (see " + log + ")."); return ${LAUNCHER_EXIT.serverStart}; }

    string reply;
    if (OwnerGone()) return ${LAUNCHER_EXIT.ownerEnded};
    int got = Http("GET", url + "/api/session/" + Uri.EscapeDataString(session), auth, null, out reply);
    if (intent == "new") {
      if (got == 200) { Say("a session " + session + " already exists: Combwork doesn't take another's session."); return ${LAUNCHER_EXIT.sessionClash}; }
      if (got != 404) { Say("OpenCode's server couldn't be asked for the session (HTTP " + got + ")."); return ${LAUNCHER_EXIT.sessionCreate}; }
      if (OwnerGone()) return ${LAUNCHER_EXIT.ownerEnded};
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
    if (OwnerGone()) return ${LAUNCHER_EXIT.ownerEnded};
    try {
      string tmp = info + ".tmp";
      File.WriteAllText(tmp, "{\"url\":" + J(url) + ",\"port\":" + port + ",\"serverPid\":" + serve.Id + ",\"sessionId\":" + J(session) + ",\"pid\":" + Process.GetCurrentProcess().Id + "}");
      if (File.Exists(info)) File.Delete(info);
      File.Move(tmp, info);
    } catch (Exception e) { Say("Combwork couldn't record OpenCode's server (" + e.Message + ")."); return ${LAUNCHER_EXIT.infoWrite}; }

    var t = new List<string> { "--server", url, "--session", session };
    t.AddRange(tuiArgs);
    t.Add(cwd);
    // The event stream (HI-2760): subscribed, and a settled baseline posted to Combwork, before the TUI can take input;
    // failing that, the launch fails and its job ends the server, so a retry starts clean (design s22).
    if (hookUrl != "") {
      CwStream.Url = url; CwStream.Auth = auth; CwStream.Session = session; CwStream.HookUrl = hookUrl; CwStream.HookToken = E("CW_HOOK_TOKEN"); CwStream.Intent = intent; CwStream.StreamVia = streamVia;
      CwStream.Abandoned = OwnerGone;
      if (!CwStream.Start(DateTime.UtcNow.AddMilliseconds(readyMs))) {
        if (OwnerGone()) { Say("Combwork ended while OpenCode was starting."); return ${LAUNCHER_EXIT.ownerEnded}; }
        Say("OpenCode didn't start: Combwork couldn't follow its session (" + CwStream.LastProblem + ").");
        return ${LAUNCHER_EXIT.baseline};
      }
    }
    if (OwnerGone()) return ${LAUNCHER_EXIT.ownerEnded};
    var ts = Start(t);
    ts.WorkingDirectory = cwd;
    Process tui;
    try { tui = Process.Start(ts); } catch (Exception e) { Say("OpenCode's interface couldn't be run (" + e.Message + ")."); return ${LAUNCHER_EXIT.tuiStart}; }
    var waits = new List<WaitHandle>();
    waits.Add(Exits(tui));
    waits.Add(Exits(serve));
    if (ownerWait != null) waits.Add(ownerWait);
    int which = WaitHandle.WaitAny(waits.ToArray());
    if (which == 0) { tui.WaitForExit(); return tui.ExitCode; }
    if (which == 1) { Say("OpenCode's server ended (see " + log + ")."); return ${LAUNCHER_EXIT.serverEnded}; }
    Say("Combwork ended: OpenCode and its server end with it.");
    return ${LAUNCHER_EXIT.ownerEnded};
  }
}
`

/**
 * The PowerShell the terminal runs: compiles the launcher (its source in the launch's private folder: CW_OC_CS) and runs
 * it. No cmdlet but Add-Type. A failure to compile ends it with a message (the terminal's, English).
 */
const BOOTSTRAP = `
try { Add-Type -TypeDefinition ([System.IO.File]::ReadAllText($env:CW_OC_CS)) -ReferencedAssemblies System.Web.Extensions -ErrorAction Stop } catch { [Console]::Error.WriteLine("Combwork: OpenCode didn't start: its launcher couldn't be compiled ($($_.Exception.Message))."); exit ${LAUNCHER_EXIT.job} }
exit [CwOpencode]::Run()
`

export const LAUNCHER_ARGS = ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(BOOTSTRAP, 'utf16le').toString('base64')] // i18n-ignore: a command line's arguments

/** What the launcher is told (its environment: nothing on its command line is quoted twice). */
export interface LauncherInput {
  /** What runs opencode: its .exe, a .cmd/.bat (run through cmd.exe), or a Node launcher's node (with `prefix`). */
  executable: string
  /** Arguments before opencode's own: a Node launcher's script (toSpawnable's shim), else none. */
  prefix?: string[]
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
  /** Combwork's hook endpoint for this launch, where the event stream and snapshots go (HI-2760); none: not followed. */
  hookUrl?: string
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
    CW_OC_PREFIX: (i.prefix ?? []).join('\u001f'),
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
    CW_OC_HOOK_URL: i.hookUrl ?? '',
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
