'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');

let shutdownPending = false;

// Use the Windows shutdown API so the countdown is cancellable and applications with unsaved work
// get a chance to ask the user. The script is fixed, contains no user input, and runs without a profile.
const POWERSHELL = String.raw`$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;

public static class CapriPowerControl {
  [StructLayout(LayoutKind.Sequential)] private struct Luid { public uint LowPart; public int HighPart; }
  [StructLayout(LayoutKind.Sequential)] private struct TokenPrivileges { public uint Count; public Luid Luid; public uint Attributes; }

  [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", EntryPoint = "LookupPrivilegeValueW", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool LookupPrivilegeValue(string system, string name, out Luid luid);
  [DllImport("advapi32.dll", SetLastError = true)] private static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivileges state, uint length, IntPtr previous, IntPtr returnedLength);
  [DllImport("advapi32.dll", EntryPoint = "InitiateSystemShutdownExW", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool InitiateSystemShutdownEx(string machine, string message, uint timeout, bool forceAppsClosed, bool reboot, uint reason);
  [DllImport("advapi32.dll", EntryPoint = "AbortSystemShutdownW", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool AbortSystemShutdown(string machine);

  private static int WithShutdownPrivilege(Func<int> operation) {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), 0x20 | 0x8, out token)) return Marshal.GetLastWin32Error();
    try {
      Luid luid;
      if (!LookupPrivilegeValue(null, "SeShutdownPrivilege", out luid)) return Marshal.GetLastWin32Error();
      TokenPrivileges state = new TokenPrivileges { Count = 1, Luid = luid, Attributes = 0x2 };
      if (!AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero)) return Marshal.GetLastWin32Error();
      int privilegeError = Marshal.GetLastWin32Error();
      if (privilegeError == 1300) return privilegeError;
      return operation();
    } finally { CloseHandle(token); }
  }

  public static int Schedule() {
    return WithShutdownPrivilege(() => InitiateSystemShutdownEx(null, "Arrêt demandé par Capri. Enregistre ton travail.", 30, false, false, 0x80040000) ? 0 : Marshal.GetLastWin32Error());
  }
  public static int Cancel() {
    return WithShutdownPrivilege(() => AbortSystemShutdown(null) ? 0 : Marshal.GetLastWin32Error());
  }
}
'@
Add-Type -TypeDefinition $source
`;

function run(method) {
  return new Promise((resolve) => {
    const windowsDir = process.env.WINDIR || 'C:\\Windows';
    const executable = path.join(windowsDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = `${POWERSHELL}\nexit [CapriPowerControl]::${method}()`;
    execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    }, (error) => resolve(error ? { ok: false, code: 'failed' } : { ok: true }));
  });
}

async function schedule() {
  if (process.platform !== 'win32') return { ok: false, code: 'unsupported' };
  if (shutdownPending) return { ok: true, alreadyPending: true };
  const result = await run('Schedule');
  if (result.ok) shutdownPending = true;
  return result;
}

async function cancel() {
  if (process.platform !== 'win32') return { ok: false, code: 'unsupported' };
  if (!shutdownPending) return { ok: false, code: 'none' };
  const result = await run('Cancel');
  if (result.ok) shutdownPending = false;
  return result;
}

module.exports = { schedule, cancel };
