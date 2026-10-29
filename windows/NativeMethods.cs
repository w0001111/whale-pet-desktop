using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;

namespace WhalePet.Windows;

internal static class NativeMethods
{
    internal const int WM_MOUSEACTIVATE = 0x21, WM_NCHITTEST = 0x84, MA_NOACTIVATE = 3, HTTRANSPARENT = -1;
    private const int GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000, WS_EX_TRANSPARENT = 0x20;
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct MonitorInfo { public int Size; public RECT Monitor, Work; public uint Flags; }
    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] private static extern IntPtr GetWindowLongPtrW(IntPtr hwnd, int index);
    [DllImport("user32.dll")] private static extern IntPtr SetWindowLongPtrW(IntPtr hwnd, int index, IntPtr value);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfoW(IntPtr monitor, ref MonitorInfo info);

    internal static Point CursorPosition() { GetCursorPos(out POINT value); return new Point(value.X, value.Y); }
    internal static void ToolWindow(Window window, bool noActivate)
    {
        IntPtr handle = new WindowInteropHelper(window).Handle;
        if (handle == IntPtr.Zero) return;
        long style = GetWindowLongPtrW(handle, GWL_EXSTYLE).ToInt64() | WS_EX_TOOLWINDOW;
        style = noActivate ? style | WS_EX_NOACTIVATE : style & ~WS_EX_NOACTIVATE;
        SetWindowLongPtrW(handle, GWL_EXSTYLE, new IntPtr(style));
    }
    internal static void InputTransparent(Window window, bool transparent)
    {
        IntPtr handle = new WindowInteropHelper(window).Handle;
        if (handle == IntPtr.Zero) return;
        long previous = GetWindowLongPtrW(handle, GWL_EXSTYLE).ToInt64();
        long next = transparent ? previous | WS_EX_TRANSPARENT : previous & ~WS_EX_TRANSPARENT;
        if (previous != next) SetWindowLongPtrW(handle, GWL_EXSTYLE, new IntPtr(next));
    }
    internal static Rect WorkArea(Window window)
    {
        var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        IntPtr monitor = MonitorFromWindow(new WindowInteropHelper(window).Handle, 2);
        if (!GetMonitorInfoW(monitor, ref info)) return SystemParameters.WorkArea;
        Matrix matrix = PresentationSource.FromVisual(window)?.CompositionTarget?.TransformFromDevice ?? Matrix.Identity;
        Point a = matrix.Transform(new Point(info.Work.Left, info.Work.Top)), b = matrix.Transform(new Point(info.Work.Right, info.Work.Bottom));
        return new Rect(a, b);
    }

    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits
    {
        public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong A, B, C, D, E, F; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits
    { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObjectW(IntPtr attributes, string? name);
    [DllImport("kernel32.dll")] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);
    [DllImport("kernel32.dll")] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    private sealed class OwnedJob : IDisposable
    {
        private IntPtr _handle;
        public OwnedJob(IntPtr handle) { _handle = handle; }
        public void Dispose() { if (_handle != IntPtr.Zero) { CloseHandle(_handle); _handle = IntPtr.Zero; } }
    }
    internal static IDisposable? OwnChild(Process process)
    {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return null;
        var value = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2000 } }; // KILL_ON_JOB_CLOSE, owned child only.
        if (!SetInformationJobObject(job, 9, ref value, (uint)Marshal.SizeOf<ExtendedLimits>()) || !AssignProcessToJobObject(job, process.Handle))
        { CloseHandle(job); return null; }
        return new OwnedJob(job);
    }
}
