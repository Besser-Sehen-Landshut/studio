// Moves and deletes folder trees of crew users (their profiles) as an administrator or SYSTEM,
// for src/crew-accounts.ts. It never follows a link: every entry is opened as itself
// (FILE_FLAG_OPEN_REPARSE_POINT), and a link or junction is deleted as the link. It changes no ACL:
// with the backup and restore privileges enabled, an entry is listed, moved and deleted whatever
// its DACL says (FILE_FLAG_BACKUP_SEMANTICS), so a Deny entry the crew set cannot stop it and no
// DACL is ever handed down a tree. Paths go to Windows with the \\?\ prefix, so length is no limit.
//
// A tree is deleted a bounded number of entries at a time (Prune): each call removes up to its
// budget and says whether the tree is gone, so a huge tree goes away over several calls and never
// blocks anything. Memory grows with the depth only: the walk keeps the current path and nothing
// else, and lists a folder anew (its first entries) each time it comes back to it.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
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
  const int FILE_RENAME_INFO = 3;
  const int FILE_DISPOSITION_INFO = 4;
  const int FILE_FULL_DIRECTORY_INFO = 14;
  const int FILE_FULL_DIRECTORY_RESTART_INFO = 15;
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
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle h, int cls, IntPtr info, uint size);
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

  /** What one Prune call did: entries deleted, and whether nothing is left to delete. */
  public class PruneResult {
    public long Deleted;
    public bool Done;
  }

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

  static void Privileges() {
    Enable("SeBackupPrivilege");
    Enable("SeRestorePrivilege");
  }

  static string Long(string path) {
    return path.StartsWith(@"\\?\") ? path.TrimEnd('\\') : @"\\?\" + path.TrimEnd('\\');
  }

  /** The entry itself, never what a link points to; null when it is not there. */
  static SafeFileHandle Open(string p) {
    SafeFileHandle h = CreateFileW(p, DELETE | LIST_OR_READ | READ_ATTRIBUTES | WRITE_ATTRIBUTES | SYNCHRONIZE, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, BACKUP_SEMANTICS | OPEN_REPARSE_POINT, IntPtr.Zero);
    if (!h.IsInvalid) return h;
    int e = Marshal.GetLastWin32Error();
    h.Dispose();
    if (e == 2 || e == 3) return null;
    throw new Win32Exception(e, p);
  }

  static BasicInfo Info(SafeFileHandle h, string p) {
    BasicInfo info;
    if (!GetFileInformationByHandleEx(h, FILE_BASIC_INFO, out info, (uint)Marshal.SizeOf(typeof(BasicInfo)))) throw new Win32Exception(Marshal.GetLastWin32Error(), p);
    return info;
  }

  static bool RealFolder(BasicInfo info) {
    return (info.Attributes & ATTR_DIRECTORY) != 0 && (info.Attributes & ATTR_REPARSE_POINT) == 0;
  }

  /**
   * Moves a folder (a profile) to `to`, one rename on the same volume, whatever its DACL says. It
   * must be a real folder, never a link.
   */
  public static void Move(string from, string to) {
    Privileges();
    string src = Long(from);
    SafeFileHandle h = Open(src);
    if (h == null) return;
    using (h) {
      if (!RealFolder(Info(h, src))) throw new InvalidOperationException(from + " is not a plain folder");
      // FILE_RENAME_INFO: ReplaceIfExists, RootDirectory, FileNameLength, FileName (an NT path).
      string target = @"\??\" + Long(to).Substring(4);
      byte[] name = Encoding.Unicode.GetBytes(target);
      int nameAt = IntPtr.Size * 2 + 4;
      int size = nameAt + name.Length + 2;
      IntPtr buffer = Marshal.AllocHGlobal(size);
      try {
        for (int i = 0; i < size; i++) Marshal.WriteByte(buffer, i, 0);
        Marshal.WriteInt32(buffer, IntPtr.Size * 2, name.Length);
        Marshal.Copy(name, 0, IntPtr.Add(buffer, nameAt), name.Length);
        if (!SetFileInformationByHandle(h, FILE_RENAME_INFO, buffer, (uint)size)) throw new Win32Exception(Marshal.GetLastWin32Error(), from + " -> " + to);
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }
  }

  /**
   * Deletes up to `budget` entries below `root` (and `root` itself unless `keepRoot`), a link as
   * the link. `afterList` (tests) runs each time a folder is listed. Each entry is opened relative
   * to the open handle of its folder, so a deep tree costs no long path to parse; the walk holds one
   * handle per level and the current path, nothing per entry.
   */
  public static PruneResult Prune(string root, long budget, bool keepRoot, Action<string> afterList) {
    Privileges();
    StringBuilder path = new StringBuilder(Long(root));
    Stack<int> lengths = new Stack<int>();
    Stack<SafeFileHandle> above = new Stack<SafeFileHandle>();
    PruneResult r = new PruneResult();
    SafeFileHandle h = Open(path.ToString());
    if (h == null) { r.Done = true; return r; }
    long steps = 0;
    // Each call walks down to where the last one stopped: up to the deepest path (16,383 levels).
    long maxSteps = budget * 4 + 40000;
    try {
      while (r.Deleted < budget && steps++ < maxSteps) {
        string p = path.ToString();
        BasicInfo info = Info(h, p);
        bool atRoot = above.Count == 0;
        if (!RealFolder(info)) {
          if (atRoot && keepRoot) throw new InvalidOperationException(root + " is not a plain folder");
          Delete(h, p, info);
          r.Deleted++;
          h.Dispose();
          if (atRoot) { h = null; r.Done = true; return r; }
          h = above.Pop();
          path.Length = lengths.Pop();
          continue;
        }
        string first = First(h, p);
        if (afterList != null) afterList(p);
        if (first == null) {
          if (atRoot && keepRoot) { r.Done = true; return r; }
          // Something may have appeared since the listing: then the folder is listed again.
          if (!TryDelete(h, p, info)) continue;
          r.Deleted++;
          h.Dispose();
          if (atRoot) { h = null; r.Done = true; return r; }
          h = above.Pop();
          path.Length = lengths.Pop();
          continue;
        }
        SafeFileHandle child = OpenIn(h, first, p);
        // Gone since the listing: list again.
        if (child == null) continue;
        above.Push(h);
        lengths.Push(path.Length);
        path.Append('\\').Append(first);
        h = child;
      }
      return r;
    } finally {
      if (h != null) h.Dispose();
      while (above.Count > 0) above.Pop().Dispose();
    }
  }

  [StructLayout(LayoutKind.Sequential)]
  struct UnicodeString { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)]
  struct ObjectAttributes { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
  [StructLayout(LayoutKind.Sequential)]
  struct IoStatusBlock { public IntPtr Status; public IntPtr Information; }
  [DllImport("ntdll.dll")]
  static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref ObjectAttributes attributes, out IoStatusBlock io, IntPtr allocation, uint fileAttributes, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
  [DllImport("ntdll.dll")]
  static extern int RtlNtStatusToDosError(int status);

  /** An entry of the folder `dir` by its name, opened as itself; null when it is not there. */
  static SafeFileHandle OpenIn(SafeFileHandle dir, string name, string p) {
    IntPtr buffer = Marshal.StringToHGlobalUni(name);
    IntPtr unicode = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
    bool added = false;
    try {
      dir.DangerousAddRef(ref added);
      UnicodeString u = new UnicodeString { Length = (ushort)(name.Length * 2), MaximumLength = (ushort)(name.Length * 2), Buffer = buffer };
      Marshal.StructureToPtr(u, unicode, false);
      ObjectAttributes oa = new ObjectAttributes {
        Length = Marshal.SizeOf(typeof(ObjectAttributes)),
        RootDirectory = dir.DangerousGetHandle(),
        ObjectName = unicode,
        Attributes = 0x40,
      };
      SafeFileHandle h;
      IoStatusBlock io;
      // FILE_OPEN; FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_FOR_BACKUP_INTENT | FILE_OPEN_REPARSE_POINT.
      int status = NtCreateFile(out h, DELETE | LIST_OR_READ | READ_ATTRIBUTES | WRITE_ATTRIBUTES | SYNCHRONIZE, ref oa, out io, IntPtr.Zero, 0, SHARE_ALL, 1, 0x20 | 0x4000 | 0x200000, IntPtr.Zero, 0);
      if (status >= 0) return h;
      h.Dispose();
      // STATUS_OBJECT_NAME_NOT_FOUND, STATUS_OBJECT_PATH_NOT_FOUND
      if ((uint)status == 0xC0000034 || (uint)status == 0xC000003A) return null;
      throw new Win32Exception(RtlNtStatusToDosError(status), p + "\\" + name);
    } finally {
      if (added) dir.DangerousRelease();
      Marshal.FreeHGlobal(unicode);
      Marshal.FreeHGlobal(buffer);
    }
  }

  /** Deletes the whole tree at `path`, however many calls of Prune it takes. */
  public static void Remove(string path, Action<string> afterList) {
    for (;;) {
      if (Prune(path, 100000, false, afterList).Done) return;
    }
  }

  /** The first entry of a folder, from its start; null when it is empty. */
  static string First(SafeFileHandle h, string p) {
    IntPtr buffer = Marshal.AllocHGlobal(4096);
    try {
      int cls = FILE_FULL_DIRECTORY_RESTART_INFO;
      for (;;) {
        if (!GetFileInformationByHandleEx(h, cls, buffer, 4096)) {
          int e = Marshal.GetLastWin32Error();
          if (e == 18) return null;
          throw new Win32Exception(e, p);
        }
        cls = FILE_FULL_DIRECTORY_INFO;
        int offset = 0;
        for (;;) {
          IntPtr entry = IntPtr.Add(buffer, offset);
          int next = Marshal.ReadInt32(entry, 0);
          int length = Marshal.ReadInt32(entry, 60);
          string name = Marshal.PtrToStringUni(IntPtr.Add(entry, 68), length / 2);
          if (name != "." && name != "..") return name;
          if (next == 0) break;
          offset += next;
        }
      }
    } finally {
      Marshal.FreeHGlobal(buffer);
    }
  }

  static bool TryDelete(SafeFileHandle h, string p, BasicInfo info) {
    try {
      Delete(h, p, info);
      return true;
    } catch (Win32Exception e) {
      // ERROR_DIR_NOT_EMPTY: an entry appeared after the listing.
      if (e.NativeErrorCode == 145) return false;
      throw;
    }
  }

  static void Delete(SafeFileHandle h, string p, BasicInfo info) {
    // Delete now, POSIX-style, read-only or not.
    DispositionEx ex = new DispositionEx { Flags = 0x1 | 0x2 | 0x10 };
    if (SetFileInformationByHandle(h, FILE_DISPOSITION_INFO_EX, ref ex, 4)) return;
    int first = Marshal.GetLastWin32Error();
    if (first == 145) throw new Win32Exception(first, p);
    // Older Windows: clear read-only, then the plain disposition.
    if ((info.Attributes & 1) != 0) {
      BasicInfo plain = new BasicInfo { Attributes = (info.Attributes & ~1u) == 0 ? 0x80u : (info.Attributes & ~1u) };
      SetFileInformationByHandle(h, FILE_BASIC_INFO, ref plain, (uint)Marshal.SizeOf(typeof(BasicInfo)));
    }
    Disposition d = new Disposition { Delete = 1 };
    if (!SetFileInformationByHandle(h, FILE_DISPOSITION_INFO, ref d, 1)) throw new Win32Exception(Marshal.GetLastWin32Error(), p);
  }
}
