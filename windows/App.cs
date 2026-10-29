using System;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;

namespace WhalePet.Windows;

public static class Program
{
    public const string Version = "0.2.0-windows.1";
    [STAThread]
    public static int Main(string[] args)
    {
        if (Array.IndexOf(args, "--version") >= 0) { Console.WriteLine("Whale Pet " + Version); return 0; }
        if (Array.IndexOf(args, "--diagnostics") >= 0) { Diagnostics(); return 0; }
        if (Array.IndexOf(args, "--self-test") >= 0)
        {
            string? output = null;
            int index = Array.IndexOf(args, "--self-test-output");
            if (index >= 0 && index + 1 < args.Length) output = args[index + 1];
            var testApp = new App(); testApp.InitializeComponent();
            return WindowsSelfTest.Run(output);
        }
        string key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(ServiceClient.ResolveApplicationRoot())))[..16];
        using var singleton = new Mutex(true, "Local\\WhalePet.Desktop." + key, out bool created);
        if (!created) return 0;
        var app = new App(); app.InitializeComponent();
        try { return app.Run(); } finally { try { singleton.ReleaseMutex(); } catch { } }
    }
    private static void Diagnostics()
    {
        string resources = Path.Combine(AppContext.BaseDirectory, "service");
        var result = new { version = Version, architecture = System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString(),
            applicationDirectory = ServiceClient.ResolveApplicationRoot(), dataDirectory = Path.Combine(ServiceClient.ResolveApplicationRoot(), "data"),
            resourceDirectory = resources, serviceEntryExists = File.Exists(Path.Combine(resources, "service.mjs")),
            assetsExist = File.Exists(Path.Combine(resources, "assets", "pet.png")),
            nodeExecutableExists = File.Exists(Path.Combine(AppContext.BaseDirectory, "runtime", "bin", "node.exe")),
            codexExecutableExists = File.Exists(Path.Combine(AppContext.BaseDirectory, "runtime", "codex.exe")),
            offlinePetAvailable = true, screenshotsDefaultEnabled = false, appInfoDefaultEnabled = false,
            windowsScreenCaptureSupported = false, windowsForegroundInformationSupported = false,
            guiStarted = false, serviceStarted = false, userStateRead = false };
        Console.WriteLine(JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }));
    }
}

public partial class App : System.Windows.Application
{
    private ServiceClient? _service;
    private PetWindow? _pet;
    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        _service = new ServiceClient();
        _pet = new PetWindow(_service); MainWindow = _pet; _pet.Show();
        try { await _service.StartAsync(); if (!_pet.IsClosing) _pet.ShowFirstSetupIfNeeded(); }
        catch { if (!_pet.IsClosing) _pet.ShowBubble("本机服务暂未连接，离线动作仍可使用。请确认已解压完整发行包，再从菜单检查 AI 连接设置。"); }
    }
    protected override void OnExit(ExitEventArgs e)
    {
        if (_service != null) { try { _service.StopAsync().GetAwaiter().GetResult(); } catch { } }
        base.OnExit(e);
    }
}
