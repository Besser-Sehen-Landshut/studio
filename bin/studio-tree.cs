// Deletes a folder tree of a crew user's (a profile) as an administrator or SYSTEM, for
// src/crew-accounts.ts. It never follows a link: every entry is opened as itself
// (FILE_FLAG_OPEN_REPARSE_POINT), and a link or junction is deleted as the link. It changes no ACL:
// with the backup and restore privileges enabled, an entry is listed and deleted whatever its DACL
// says (FILE_FLAG_BACKUP_SEMANTICS), so a Deny entry the crew set cannot stop it and no new DACL is
// ever handed down a tree. Paths go to Windows with the \\?\ prefix, so length is no limit.
// A folder that is not empty when it is deleted (something appeared in it after it was listed)
// fails the pass; the whole tree is walked again, up to five times. The walk keeps a stack of its
// own, so no depth overflows it; a tree deeper than MaxDepth folders or with more than MaxEntries
// entries is refused with a clear error, never retried.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class StudioTree {
  const uint DELETE = 0x00010000;
  const uint LIST_OR_READ = 0x00000001;
  const uint READ_ATTRIBUTES = 0x00000080;
  const uint WRITE_ATTRIBUTES = 0x00000100;
  const uint SYNCHRONIZE = 0x00100000;
  const uint SHARE_ALL = 7;
  const uint OPEN_EXISTING = 3;
  const uint BACKUP_SEMANTICS = 0x02000000;
  const uint OPEN_REPARSE_POINT = 0x00200000;
  const uint ATTR_DIRECTORY = 0x10;
  const uint ATTR_REPARSE_POINT = 0x400;
  const int FILE_BASIC_INFO = 0;
  const int FILE_DISPOSITION_INFO = 4;
  const int FILE_FULL_DIRECTORY_INFO = 14;
  const int FILE_DISPOSITION_INFO_EX = 21;

  [StructLayout(LayoutKind.Sequential)]
  struct BasicInfo { public long Creation, Access, Write, Change; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)]
  struct Disposition { public byte Delete; }
  [StructLayout(LayoutKind.Sequential)]
  struct DispositionEx { public uint Flags; }
  [StructLayout(LayoutKind.Sequential)]
  struct Luid { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)]
  struct TokenPrivilege { public uint Count; public Luid Luid; public uint Attributes; }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int cls, out BasicInfo info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int cls, IntPtr buffer, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle h, int cls, ref DispositionEx info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle h, int cls, ref Disposition info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle h, int cls, ref BasicInfo info, uint size);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool LookupPrivilegeValueW(string system, string name, out Luid luid);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivilege state, uint length, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr h);

  static void Enable(string name) {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), 0x28, out token)) throw new Win32Exception();
    try {
      Luid luid;
      if (!LookupPrivilegeValueW(null, name, out luid)) throw new Win32Exception();
      TokenPrivilege tp = new TokenPrivilege { Count = 1, Luid = luid, Attributes = 2 };
      if (!AdjustTokenPrivileges(token, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
      // ERROR_NOT_ALL_ASSIGNED: the token does not hold the privilege (no administrator).
      if (Marshal.GetLastWin32Error() == 1300) throw new InvalidOperationException(name + " is not held: run elevated");
    } finally {
      CloseHandle(token);
    }
  }

  static string Long(string path) {
    return path.StartsWith(@"\\?\") ? path : @"\\?\" + path;
  }

  /** Deletes the tree at `path`, a link as the link; `afterList` (tests) runs after each listing. */
  /** Too deep or too many entries: refused at once, never retried. */
  public class TooLarge : Exception {
    public TooLarge(string message) : base(message) { }
  }

  public const int MaxDepth = 20000;
  public const long MaxEntries = 5000000;

  /** Deletes the tree at `path`, a link as the link; `afterList` (tests) runs after each listing. */
  public static void Remove(string path, Action<string> afterList) {
    Remove(path, afterList, MaxDepth, MaxEntries);
  }

  public static void Remove(string path, Action<string> afterList, int maxDepth, long maxEntries) {
    Enable("SeBackupPrivilege");
    Enable("SeRestorePrivilege");
    string p = Long(path);
    for (int pass = 0; ; pass++) {
      try {
        Walk(p, afterList, maxDepth, maxEntries);
        return;
      } catch (TooLarge) {
        throw;
      } catch (Exception) {
        if (pass >= 4) throw;
      }
    }
  }

  struct Step { public string Path; public int Depth; public bool Listed; }

  // One walk, with a stack of its own (no recursion, so no depth can overflow it): a folder is
  // listed when it is first taken off the stack and deleted when it comes off again, after all it
  // held. Everything else is deleted at once.
  static void Walk(string root, Action<string> afterList, int maxDepth, long maxEntries) {
    Stack<Step> todo = new Stack<Step>();
    todo.Push(new Step { Path = root, Depth = 0, Listed = false });
    long seen = 0;
    while (todo.Count > 0) {
      Step step = todo.Pop();
      SafeFileHandle h = CreateFileW(step.Path, DELETE | LIST_OR_READ | READ_ATTRIBUTES | WRITE_ATTRIBUTES | SYNCHRONIZE, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, BACKUP_SEMANTICS | OPEN_REPARSE_POINT, IntPtr.Zero);
      if (h.IsInvalid) {
        int e = Marshal.GetLastWin32Error();
        if (e == 2 || e == 3) continue;
        throw new Win32Exception(e, step.Path);
      }
      using (h) {
        BasicInfo info;
        if (!GetFileInformationByHandleEx(h, FILE_BASIC_INFO, out info, (uint)Marshal.SizeOf(typeof(BasicInfo)))) throw new Win32Exception(Marshal.GetLastWin32Error(), step.Path);
        bool folder = (info.Attributes & ATTR_DIRECTORY) != 0 && (info.Attributes & ATTR_REPARSE_POINT) == 0;
        if (folder && !step.Listed) {
          if (step.Depth > maxDepth) throw new TooLarge("the tree is deeper than " + maxDepth + " folders: " + root);
          List<string> names = List(h, step.Path);
          seen += names.Count;
          if (seen > maxEntries) throw new TooLarge("the tree holds more than " + maxEntries + " entries: " + root);
          if (afterList != null) afterList(step.Path);
          todo.Push(new Step { Path = step.Path, Depth = step.Depth, Listed = true });
          foreach (string name in names) todo.Push(new Step { Path = step.Path + "\\" + name, Depth = step.Depth + 1, Listed = false });
          continue;
        }
        Delete(h, step.Path, info);
      }
    }
  }

  static List<string> List(SafeFileHandle h, string p) {
    List<string> names = new List<string>();
    IntPtr buffer = Marshal.AllocHGlobal(65536);
    try {
      for (;;) {
        if (!GetFileInformationByHandleEx(h, FILE_FULL_DIRECTORY_INFO, buffer, 65536)) {
          int e = Marshal.GetLastWin32Error();
          if (e == 18) break;
          throw new Win32Exception(e, p);
        }
        int offset = 0;
        for (;;) {
          IntPtr entry = IntPtr.Add(buffer, offset);
          int next = Marshal.ReadInt32(entry, 0);
          int length = Marshal.ReadInt32(entry, 60);
          string name = Marshal.PtrToStringUni(IntPtr.Add(entry, 68), length / 2);
          if (name != "." && name != "..") names.Add(name);
          if (next == 0) break;
          offset += next;
        }
      }
    } finally {
      Marshal.FreeHGlobal(buffer);
    }
    return names;
  }

  static void Delete(SafeFileHandle h, string p, BasicInfo info) {
    // Delete now, POSIX-style, read-only or not.
    DispositionEx ex = new DispositionEx { Flags = 0x1 | 0x2 | 0x10 };
    if (SetFileInformationByHandle(h, FILE_DISPOSITION_INFO_EX, ref ex, 4)) return;
    // Older Windows: clear read-only, then the plain disposition.
    if ((info.Attributes & 1) != 0) {
      BasicInfo plain = new BasicInfo { Attributes = (info.Attributes & ~1u) == 0 ? 0x80u : (info.Attributes & ~1u) };
      SetFileInformationByHandle(h, FILE_BASIC_INFO, ref plain, (uint)Marshal.SizeOf(typeof(BasicInfo)));
    }
    Disposition d = new Disposition { Delete = 1 };
    if (!SetFileInformationByHandle(h, FILE_DISPOSITION_INFO, ref d, 1)) throw new Win32Exception(Marshal.GetLastWin32Error(), p);
  }
}
