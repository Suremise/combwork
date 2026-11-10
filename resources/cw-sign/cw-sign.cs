// cw-sign.exe (HI-2867, SPEC §16.9.5): the signer program Combwork gives agents' sessions (gpg.program and
// gpg.ssh.program, in their environment only). Git runs it with the signer's arguments; it hands them, untouched, to
// cw-sign.js (run by Combwork's own executable as Node), which decides what really signs.
//
// Why a program of its own: git names one program, with no arguments of its own, and a .cmd loses arguments to cmd's
// parsing (%VAR% expanded, quotes dropped: measured on HI-2867), and a #!/bin/sh script runs only where git finds sh on
// PATH. So the arguments travel in CW_SIGN_ARGV (their count, then base64 of their UTF-8 joined by NUL), never re-quoted
// on a command line; stdin, stdout and stderr are relayed byte for byte through pipes of its own (git's own are never
// inherited by what it starts: below).
//
// Ending: it puts itself in a job object that ends everything in it when its last handle closes (the handle is never
// inherited, so only this process holds it). Ending this process (its session ending its tree) ends cw-sign.js and the
// signer with it, detached or not; the job holds only what this invocation started. Once cw-sign.js has finished, the
// job stops ending what is left (a gpg-agent gpg started stays, as it would have). A job it can't make or join is a
// failure (exit 2), never a signature skipped.
//
// Built from this file at each build by Windows' own .NET Framework compiler (electron.vite.config.ts, scripts/
// buildSignLauncher.mjs): no dependency, nothing prebuilt in the repository.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class CwSign {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, uint size);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);

  [DllImport("kernel32.dll")]
  static extern void DeleteProcThreadAttributeList(IntPtr list);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, string environment, string directory, ref StartupInfoEx startup, out ProcessInformation info);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll")]
  static extern uint WaitForSingleObject(IntPtr handle, uint ms);

  [DllImport("kernel32.dll")]
  static extern bool GetExitCodeProcess(IntPtr process, out uint code);

  [StructLayout(LayoutKind.Sequential)]
  struct SecurityAttributes {
    public int Length;
    public IntPtr Descriptor;
    public bool Inherit;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct StartupInfo {
    public int cb;
    public string Reserved, Desktop, Title;
    public int X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
    public short ShowWindow, Reserved2;
    public IntPtr Reserved2Ptr, StdInput, StdOutput, StdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct StartupInfoEx {
    public StartupInfo StartupInfo;
    public IntPtr AttributeList;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInformation {
    public IntPtr Process, Thread;
    public int ProcessId, ThreadId;
  }

  const uint HandleFlagInherit = 1;
  const int StartfUseStdHandles = 0x100;
  const uint ExtendedStartupInfoPresent = 0x80000, CreateUnicodeEnvironment = 0x400, CreateNoWindow = 0x08000000;
  static readonly IntPtr HandleListAttribute = (IntPtr)0x20002;

  class Started {
    public IntPtr Process;
    public FileStream In, Out, Err;
  }

  /** A pipe whose `child` end alone is inheritable. */
  static void Pipe(bool childReads, out IntPtr child, out IntPtr mine) {
    var sa = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = true };
    IntPtr r, w;
    if (!CreatePipe(out r, out w, ref sa, 0)) throw new Exception("CreatePipe " + Marshal.GetLastWin32Error());
    child = childReads ? r : w;
    mine = childReads ? w : r;
    SetHandleInformation(mine, HandleFlagInherit, 0);
  }

  /** Starts `commandLine` with `environment`, inheriting exactly its three pipes' ends. */
  static Started Start(string commandLine, string environment) {
    IntPtr inChild, inMine, outChild, outMine, errChild, errMine;
    Pipe(true, out inChild, out inMine);
    Pipe(false, out outChild, out outMine);
    Pipe(false, out errChild, out errMine);
    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
    IntPtr list = Marshal.AllocHGlobal(size);
    IntPtr handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
    try {
      if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) throw new Exception("InitializeProcThreadAttributeList " + Marshal.GetLastWin32Error());
      Marshal.WriteIntPtr(handles, 0, inChild);
      Marshal.WriteIntPtr(handles, IntPtr.Size, outChild);
      Marshal.WriteIntPtr(handles, IntPtr.Size * 2, errChild);
      if (!UpdateProcThreadAttribute(list, 0, HandleListAttribute, handles, (IntPtr)(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero)) throw new Exception("UpdateProcThreadAttribute " + Marshal.GetLastWin32Error());
      var si = new StartupInfoEx();
      si.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
      si.StartupInfo.Flags = StartfUseStdHandles;
      si.StartupInfo.StdInput = inChild;
      si.StartupInfo.StdOutput = outChild;
      si.StartupInfo.StdError = errChild;
      si.AttributeList = list;
      ProcessInformation pi;
      if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, ExtendedStartupInfoPresent | CreateUnicodeEnvironment | CreateNoWindow, environment, null, ref si, out pi)) throw new Exception("CreateProcess " + Marshal.GetLastWin32Error());
      CloseHandle(pi.Thread);
      return new Started {
        Process = pi.Process,
        In = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(inMine, true), FileAccess.Write),
        Out = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(outMine, true), FileAccess.Read),
        Err = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(errMine, true), FileAccess.Read)
      };
    } finally {
      CloseHandle(inChild);
      CloseHandle(outChild);
      CloseHandle(errChild);
      DeleteProcThreadAttributeList(list);
      Marshal.FreeHGlobal(list);
      Marshal.FreeHGlobal(handles);
    }
  }
  /** How long, once cw-sign.js has exited, what it wrote may take to arrive (a process it left may hold its pipes). */
  const int DrainMs = 2000;
  /** cw-sign.js's exit code for a signer it ended at its bound (cw-sign.ts TIMED_OUT). */
  const int TimedOut = 124;

  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  const int ExtendedLimitInformation = 9;
  const uint KillOnJobClose = 0x2000;

  static void Relay(Stream from, Stream to) {
    var buf = new byte[65536];
    try {
      int n;
      while ((n = from.Read(buf, 0, buf.Length)) > 0) {
        to.Write(buf, 0, n);
        to.Flush();
      }
    } catch (Exception) {
      // either end went
    }
  }

  static int Remaining(DateTime end) {
    double ms = (end - DateTime.UtcNow).TotalMilliseconds;
    return ms > 0 ? (int)ms : 0;
  }

  static int Fail(string what) {
    Console.Error.WriteLine("cw-sign: " + what + " The commit was not signed, and so not made.");
    return 2;
  }

  static int Main(string[] args) {
    string exec = Environment.GetEnvironmentVariable("CW_SIGN_EXEC");
    string script = Environment.GetEnvironmentVariable("CW_SIGN_JS");
    if (string.IsNullOrEmpty(exec) || string.IsNullOrEmpty(script)) return Fail("CW_SIGN_EXEC or CW_SIGN_JS is not set.");
    // A path can't hold a double quote on Windows; one that does isn't Combwork's.
    if (script.IndexOf('"') >= 0 || script.EndsWith("\\")) return Fail("CW_SIGN_JS is not a script's path.");
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return Fail("couldn't make its job object (" + Marshal.GetLastWin32Error() + ").");
    var limits = new ExtendedLimits();
    limits.Basic.LimitFlags = KillOnJobClose;
    if (!SetInformationJobObject(job, ExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(limits))) return Fail("couldn't set up its job object (" + Marshal.GetLastWin32Error() + ").");
    // Itself first, so everything it starts is in the job from its first instruction.
    if (!AssignProcessToJobObject(job, GetCurrentProcess())) return Fail("couldn't join its job object (" + Marshal.GetLastWin32Error() + ").");
    // git's pipes stay this process's alone. Windows gives a child every inheritable handle this process has, and a
    // process the signer leaves running (gpg starting its gpg-agent) then holds git's stdout open: git waits for its end
    // for as long as the agent runs (measured on HI-2867). So cw-sign.js is started with exactly three handles to inherit
    // (PROC_THREAD_ATTRIBUTE_HANDLE_LIST): pipes of this process's own, relayed byte for byte.
    var env = new StringBuilder();
    var vars = Environment.GetEnvironmentVariables();
    var names = new System.Collections.Generic.List<string>();
    foreach (System.Collections.DictionaryEntry e in vars) {
      string k = (string)e.Key;
      if (k == "CW_SIGN_ARGV" || k == "CW_SIGN_RUN_AS_NODE" || k == "ELECTRON_RUN_AS_NODE") continue;
      names.Add(k);
    }
    names.Sort(StringComparer.OrdinalIgnoreCase);
    foreach (string k in names) env.Append(k).Append('=').Append((string)vars[k]).Append('\0');
    env.Append("CW_SIGN_ARGV=").Append(args.Length + ":" + Convert.ToBase64String(Encoding.UTF8.GetBytes(string.Join("\0", args)))).Append('\0');
    // Combwork's executable runs as Node; the caller's own value goes back to the signer (cw-sign.js).
    env.Append("CW_SIGN_RUN_AS_NODE=").Append(Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE") ?? "").Append('\0');
    env.Append("ELECTRON_RUN_AS_NODE=1").Append('\0').Append('\0');
    Started child;
    try {
      child = Start("\"" + exec + "\" \"" + script + "\"", env.ToString());
    } catch (Exception e) {
      return Fail("couldn't start " + exec + ": " + e.Message);
    }
    var stdin = Console.OpenStandardInput();
    var stdout = Console.OpenStandardOutput();
    var stderr = Console.OpenStandardError();
    var toChild = new Thread(() => {
      try {
        stdin.CopyTo(child.In);
      } catch (Exception) {
        // it stopped reading: what it needed came
      }
      try {
        child.In.Close();
      } catch (Exception) {
        // gone already
      }
    }) { IsBackground = true };
    var fromOut = new Thread(() => Relay(child.Out, stdout)) { IsBackground = true };
    var fromErr = new Thread(() => Relay(child.Err, stderr)) { IsBackground = true };
    toChild.Start();
    fromOut.Start();
    fromErr.Start();
    WaitForSingleObject(child.Process, 0xFFFFFFFF);
    uint exit;
    int code = GetExitCodeProcess(child.Process, out exit) ? (int)exit : 1;
    var drainEnd = DateTime.UtcNow.AddMilliseconds(DrainMs);
    fromOut.Join(Remaining(drainEnd));
    fromErr.Join(Remaining(drainEnd));
    stdout.Flush();
    stderr.Flush();
    // Finished, not cancelled: what the signer left running on purpose (gpg starting its gpg-agent, which serves later
    // commits and the user's own) stays. Only an ending of this process before here ends the job's processes, and a
    // signer cw-sign.js ended at its bound (TimedOut): what it started is ended with it, as this process exits.
    if (code != TimedOut) {
      limits.Basic.LimitFlags = 0;
      SetInformationJobObject(job, ExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(limits));
    }
    return code;
  }
}
