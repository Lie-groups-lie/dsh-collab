using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

internal static class McpLauncher
{
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint CreateNoWindow = 0x08000000;
    private const uint DuplicateSameAccess = 0x00000002;
    private const int StdInputHandle = -10;
    private const int StdOutputHandle = -11;
    private const int StdErrorHandle = -12;
    private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(
        IntPtr sourceProcess,
        IntPtr sourceHandle,
        IntPtr targetProcess,
        out IntPtr targetHandle,
        uint desiredAccess,
        bool inheritHandle,
        uint options);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static IntPtr DuplicateStandardHandle(int kind)
    {
        IntPtr source = GetStdHandle(kind);
        if (source == IntPtr.Zero || source == InvalidHandleValue)
        {
            return IntPtr.Zero;
        }

        IntPtr process = GetCurrentProcess();
        IntPtr duplicate;
        if (!DuplicateHandle(process, source, process, out duplicate, 0, true, DuplicateSameAccess))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return duplicate;
    }

    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            return value;
        }

        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                slashes += 1;
                continue;
            }

            if (character == '"')
            {
                result.Append('\\', slashes * 2 + 1);
                result.Append('"');
                slashes = 0;
                continue;
            }

            result.Append('\\', slashes);
            slashes = 0;
            result.Append(character);
        }
        result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length == 0)
        {
            return 64;
        }

        string configuredNode = Environment.GetEnvironmentVariable("DSH_MCP_NODE");
        string node = string.IsNullOrWhiteSpace(configuredNode) ? "node.exe" : configuredNode;
        var commandLine = new StringBuilder(Quote(node));
        foreach (string arg in args)
        {
            commandLine.Append(' ').Append(Quote(arg));
        }

        IntPtr stdin = IntPtr.Zero;
        IntPtr stdout = IntPtr.Zero;
        IntPtr stderr = IntPtr.Zero;
        ProcessInformation processInfo = new ProcessInformation();
        try
        {
            stdin = DuplicateStandardHandle(StdInputHandle);
            stdout = DuplicateStandardHandle(StdOutputHandle);
            stderr = DuplicateStandardHandle(StdErrorHandle);
            var startupInfo = new StartupInfo
            {
                cb = (uint)Marshal.SizeOf(typeof(StartupInfo)),
                dwFlags = StartfUseStdHandles,
                hStdInput = stdin,
                hStdOutput = stdout,
                hStdError = stderr,
            };

            if (!CreateProcess(
                null,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CreateNoWindow,
                IntPtr.Zero,
                Environment.CurrentDirectory,
                ref startupInfo,
                out processInfo))
            {
                return Marshal.GetLastWin32Error();
            }

            WaitForSingleObject(processInfo.hProcess, 0xFFFFFFFF);
            uint exitCode;
            return GetExitCodeProcess(processInfo.hProcess, out exitCode) ? unchecked((int)exitCode) : 1;
        }
        catch
        {
            return 1;
        }
        finally
        {
            if (stdin != IntPtr.Zero) CloseHandle(stdin);
            if (stdout != IntPtr.Zero) CloseHandle(stdout);
            if (stderr != IntPtr.Zero) CloseHandle(stderr);
            if (processInfo.hThread != IntPtr.Zero) CloseHandle(processInfo.hThread);
            if (processInfo.hProcess != IntPtr.Zero) CloseHandle(processInfo.hProcess);
        }
    }
}
