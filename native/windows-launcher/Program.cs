using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

internal static class Program
{
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint CreateNoWindow = 0x08000000;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint JobObjectExtendedLimitInformationClass = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint Infinite = 0xFFFFFFFF;
    private const uint StdInputHandle = unchecked((uint)-10);
    private const uint StdOutputHandle = unchecked((uint)-11);
    private const uint StdErrorHandle = unchecked((uint)-12);

    private static int Main(string[] args)
    {
        try
        {
            var command = ReadCommand(args);
            if (command == null)
            {
                WriteError("agy-launcher: expected --command-base64 <value>");
                return 70;
            }

            return RunChild(command);
        }
        catch (Exception error)
        {
            WriteError(string.Format("agy-launcher: {0}", error.Message));
            return 71;
        }
    }

    private static string ReadCommand(string[] args)
    {
        for (var index = 0; index + 1 < args.Length; index++)
        {
            if (!string.Equals(args[index], "--command-base64", StringComparison.Ordinal)) continue;
            try
            {
                return Encoding.UTF8.GetString(Convert.FromBase64String(args[index + 1]));
            }
            catch (FormatException error)
            {
                throw new InvalidOperationException("invalid command encoding", error);
            }
        }

        return null;
    }

    private static int RunChild(string command)
    {
        var startup = new StartupInfo
        {
            cb = Marshal.SizeOf(typeof(StartupInfo)),
            dwFlags = StartfUseStdHandles,
            hStdInput = GetStdHandle(StdInputHandle),
            hStdOutput = GetStdHandle(StdOutputHandle),
            hStdError = GetStdHandle(StdErrorHandle),
        };

        var creationFlags = CreateSuspended | CreateUnicodeEnvironment | CreateNoWindow;
        ProcessInformation processInfo;
        if (!CreateProcessW(
            null,
            new StringBuilder(command),
            IntPtr.Zero,
            IntPtr.Zero,
            true,
            creationFlags,
            IntPtr.Zero,
            null,
            ref startup,
            out processInfo))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW failed");
        }

        var job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            TerminateProcess(processInfo.hProcess, 72);
            CloseProcessHandles(processInfo);
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");
        }

        try
        {
            var limits = new JobObjectExtendedLimitInformation
            {
                BasicLimitInformation = new JobObjectBasicLimitInformation
                {
                    LimitFlags = JobObjectLimitKillOnJobClose,
                },
            };
            if (!SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformationClass,
                ref limits,
                (uint)Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation))))
            {
                TerminateProcess(processInfo.hProcess, 73);
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
            }

            if (!AssignProcessToJobObject(job, processInfo.hProcess))
            {
                TerminateProcess(processInfo.hProcess, 74);
                throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed");
            }

            if (ResumeThread(processInfo.hThread) == uint.MaxValue)
            {
                TerminateProcess(processInfo.hProcess, 75);
                throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed");
            }

            WaitForSingleObject(processInfo.hProcess, Infinite);
            uint exitCode;
            if (!GetExitCodeProcess(processInfo.hProcess, out exitCode))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetExitCodeProcess failed");
            }

            return unchecked((int)exitCode);
        }
        finally
        {
            CloseHandle(job);
            CloseProcessHandles(processInfo);
        }
    }

    private static void CloseProcessHandles(ProcessInformation processInfo)
    {
        CloseHandle(processInfo.hThread);
        CloseHandle(processInfo.hProcess);
    }

    private static void WriteError(string message)
    {
        try
        {
            Console.Error.WriteLine(message);
        }
        catch
        {
            // There may be no stderr handle when launched manually.
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
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

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        uint informationClass,
        ref JobObjectExtendedLimitInformation information,
        uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(uint standardHandle);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
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
        public uint processId;
        public uint threadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
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
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }
}
