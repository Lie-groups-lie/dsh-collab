using System;
using System.Globalization;
using System.Management;
using System.Runtime.InteropServices;

// Built as a GUI-subsystem executable: no console window, shell or PowerShell.
// This is a read-only, one-shot OS query, never a process launcher/terminator.
internal static class ProcessIdentity {
    // WMI exposes creation metadata even for processes that cannot be opened.
    // Its timestamp is lower precision than FILETIME: it can DISPROVE an old
    // identity, never grant ownership or manufacture a new birth identity.
    internal static bool DefinitelyDifferentBirth(ulong expected, long observed) {
        if (observed <= 0 || expected == 0 || expected > long.MaxValue) return false;
        long saved = (long)expected;
        long distance = saved > observed ? saved - observed : observed - saved;
        return distance > 10000; // conservative +/- 1ms
    }
    private static string ComparePublicMetadata(uint pid, ulong expected) {
        try {
            var options = new EnumerationOptions { Timeout = TimeSpan.FromSeconds(2), ReturnImmediately = false };
            using (var query = new ManagementObjectSearcher("root\\CIMV2",
                "SELECT ProcessId, CreationDate FROM Win32_Process WHERE ProcessId = " + pid.ToString(CultureInfo.InvariantCulture), options))
            using (var rows = query.Get()) {
                foreach (ManagementObject row in rows) using (row) {
                    string date = row["CreationDate"] as string;
                    if (String.IsNullOrEmpty(date) || date.Contains("*")) return "unknown";
                    long created = ManagementDateTimeConverter.ToDateTime(date).ToUniversalTime().ToFileTimeUtc();
                    return DefinitelyDifferentBirth(expected, created) ? "replaced" : "unknown";
                }
            }
        } catch { /* unavailable/denied metadata must never permit recovery */ }
        return "unknown";
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime { public uint Low; public uint High; }
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr handle, out FileTime created,
        out FileTime exited, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr handle, out uint exitCode);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private static int Main(string[] args) {
        uint pid;
        ulong expected = 0;
        if (args.Length < 1 || args.Length > 2 || !uint.TryParse(args[0], out pid) || pid == 0) return 2;
        if (args.Length == 2 && (!ulong.TryParse(args[1], out expected) || expected == 0 || expected > long.MaxValue)) return 2;
        // Birth/exit queries only require PROCESS_QUERY_LIMITED_INFORMATION.
        // SYNCHRONIZE unnecessarily rejects some service processes after PID reuse,
        // stranding a stale desktop/writer lock as "unknown" after a reboot.
        IntPtr handle = OpenProcess(0x1000, false, pid);
        if (handle == IntPtr.Zero) {
            int error = Marshal.GetLastWin32Error();
            string state = error == 87 || error == 1168 ? "dead"
                : error == 5 && expected != 0 ? ComparePublicMetadata(pid, expected) : "unknown";
            Console.WriteLine("{\"state\":\"" + state + "\"}");
            return 0;
        }
        try {
            uint exitCode;
            if (!GetExitCodeProcess(handle, out exitCode)) {
                Console.WriteLine("{\"state\":\"unknown\"}"); return 0;
            }
            if (exitCode != 259) { Console.WriteLine("{\"state\":\"dead\"}"); return 0; }
            FileTime created, exited, kernel, user;
            if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) {
                Console.WriteLine("{\"state\":\"unknown\"}");
                return 0;
            }
            ulong ticks = ((ulong)created.High << 32) | created.Low;
            Console.WriteLine("{\"state\":\"alive\",\"identity\":\"windows:" +
                ticks.ToString(CultureInfo.InvariantCulture) + "\"}");
            return 0;
        } finally { CloseHandle(handle); }
    }
}
