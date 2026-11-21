param([Parameter(Mandatory = $true)][string]$Directory)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class CodexWriterOwners {
    [StructLayout(LayoutKind.Sequential)]
    public struct UniqueProcess {
        public uint Id;
        public System.Runtime.InteropServices.ComTypes.FILETIME Start;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct ProcessInfo {
        public UniqueProcess Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string Service;
        public uint Type;
        public uint Status;
        public uint Session;
        [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
    }
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmStartSession(out uint handle, int flags, string key);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmRegisterResources(uint handle, uint count, string[] names, uint apps, IntPtr processes, uint services, IntPtr serviceNames);
    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] ProcessInfo[] processes, ref uint reasons);
    [DllImport("rstrtmgr.dll")]
    static extern int RmEndSession(uint handle);

    public static long? StartedAt(string file) {
        uint handle;
        int error = RmStartSession(out handle, 0, Guid.NewGuid().ToString("N"));
        if (error != 0) throw new Exception("Writer owner inspection failed: " + error);
        try {
            error = RmRegisterResources(handle, 1, new[] { file }, 0, IntPtr.Zero, 0, IntPtr.Zero);
            if (error != 0) throw new Exception("Writer owner registration failed: " + error);
            uint needed, count = 0, reasons = 0;
            error = RmGetList(handle, out needed, ref count, null, ref reasons);
            if (error == 0) return null;
            if (error != 234) throw new Exception("Writer owner list failed: " + error);
            ProcessInfo[] owners = null;
            for (int attempt = 0; attempt < 3 && error == 234; attempt++) {
                count = needed;
                owners = new ProcessInfo[count];
                error = RmGetList(handle, out needed, ref count, owners, ref reasons);
            }
            if (error != 0) throw new Exception("Writer owners changed during inspection: " + error);
            long? earliest = null;
            for (int index = 0; index < count; index++) {
                var identity = owners[index].Process;
                try {
                    using (var process = Process.GetProcessById((int)identity.Id)) {
                        if (!String.Equals(process.ProcessName, "codex", StringComparison.OrdinalIgnoreCase)) continue;
                        long start = process.StartTime.ToUniversalTime().ToFileTimeUtc();
                        long observed = ((long)(uint)identity.Start.dwHighDateTime << 32) | (uint)identity.Start.dwLowDateTime;
                        // Verify the Restart Manager identity before trusting a potentially reused PID.
                        if (start != observed) continue;
                        long milliseconds = start / 10000 - 11644473600000L;
                        if (!earliest.HasValue || milliseconds < earliest.Value) earliest = milliseconds;
                    }
                } catch (ArgumentException) { /* The owner exited during inspection. */ }
            }
            return earliest;
        } finally { RmEndSession(handle); }
    }
}
'@

$held = @()
foreach ($file in [IO.Directory]::EnumerateFiles($Directory, '*.lock')) {
    $stream = $null
    $locked = $false
    try {
        $stream = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        $stream.Lock(0, 1)
        $stream.Unlock(0, 1)
    } catch {
        $cause = $_.Exception
        while ($cause.InnerException) { $cause = $cause.InnerException }
        $code = $cause.HResult -band 65535
        if ($code -eq 32 -or $code -eq 33) { $locked = $true }
        elseif ($code -ne 2 -and $code -ne 3) { throw }
    } finally { if ($stream) { $stream.Dispose() } }
    if ($locked) { $held += @{ path = $file; ownerStartedAt = [CodexWriterOwners]::StartedAt($file) } }
}
ConvertTo-Json -InputObject @($held) -Compress
