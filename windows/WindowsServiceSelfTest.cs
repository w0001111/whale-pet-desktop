using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace WhalePet.Windows;

/// Exercises the real production process/HTTP/shutdown path without creating a WPF Application.
internal static class WindowsServiceSelfTest
{
    internal static async Task<int> RunAsync()
    {
        var checks = new Dictionary<string, bool>();
        var previous = new Dictionary<string, string?>();
        string root = Path.Combine(Path.GetTempPath(), "whale-native-service-probe-" + Guid.NewGuid().ToString("N"));
        ServiceClient? client = null;
        Process? owned = null;
        bool completed = false, cleanupSucceeded = false, jobAttached = false;
        void Check(string name, bool value) { checks[name] = value; if (!value) throw new InvalidOperationException(); }
        void SetEnvironment(string name, string value)
        { if (!previous.ContainsKey(name)) previous[name] = Environment.GetEnvironmentVariable(name); Environment.SetEnvironmentVariable(name, value); }
        try
        {
            Check("windows-runtime", OperatingSystem.IsWindows());
            Check("fresh-temporary-root", !Directory.Exists(root));
            Directory.CreateDirectory(root);
            string profile = Path.Combine(root, "profile"), temporary = Path.Combine(root, "tmp");
            foreach (string folder in new[] { profile, temporary, Path.Combine(profile, "Roaming"), Path.Combine(profile, "Local") }) Directory.CreateDirectory(folder);
            SetEnvironment("HOME", profile); SetEnvironment("USERPROFILE", profile);
            SetEnvironment("APPDATA", Path.Combine(profile, "Roaming")); SetEnvironment("LOCALAPPDATA", Path.Combine(profile, "Local"));
            SetEnvironment("TEMP", temporary); SetEnvironment("TMP", temporary); SetEnvironment("TMPDIR", temporary);
            SetEnvironment("WHALE_PET_DATA_DIR", root);
            SetEnvironment("NODE_BINARY", Path.Combine(AppContext.BaseDirectory, "runtime", "bin", "node.exe"));
            SetEnvironment("WHALE_PET_CODEX_BINARY", Path.Combine(AppContext.BaseDirectory, "runtime", "codex.exe"));
            client = new ServiceClient(root, Path.Combine(AppContext.BaseDirectory, "service"));
            Check("production-client-not-synthetic", !client.IsSyntheticTestRoot);
            Check("explicit-isolated-paths", string.Equals(client.AppDataRoot, Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase)
                && string.Equals(client.DataRoot, Path.Combine(Path.GetFullPath(root), "data"), StringComparison.OrdinalIgnoreCase));
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(130));
            await client.StartAsync(deadline.Token).ConfigureAwait(false);
            Check("production-client-started", client.IsRunning && client.OwnedProcessId.HasValue);
            jobAttached = client.OwnedJobAttached;
            Check("loopback-endpoint", client.UsesLoopbackEndpoint);
            string stateFile = Path.Combine(client.DataRoot, "service.json");
            Check("data-root-not-reparse", (File.GetAttributes(client.DataRoot) & FileAttributes.ReparsePoint) == 0);
            Check("state-file-not-reparse", (File.GetAttributes(stateFile) & FileAttributes.ReparsePoint) == 0);
            JsonNode state = JsonNode.Parse(await File.ReadAllTextAsync(stateFile, deadline.Token).ConfigureAwait(false)) ?? throw new InvalidOperationException();
            Check("state-owned-by-exact-child", state["pid"]?.GetValue<int>() == client.OwnedProcessId);
            owned = Process.GetProcessById(client.OwnedProcessId!.Value);
            _ = owned.Handle; // Keep a handle to this exact process, even if its PID is later reused.
            Check("child-distinct-from-parent", owned.Id != Environment.ProcessId && !owned.HasExited);
            Check("private-data-root-dacl", PrivateAccessList(new DirectoryInfo(client.DataRoot), requireProtected: true));
            Check("private-state-file-dacl", PrivateAccessList(new FileInfo(stateFile), requireProtected: false));
            JsonNode config = await client.RequestAsync("/api/config", cancellationToken: deadline.Token).ConfigureAwait(false);
            Check("offline-default-config", config["mode"]?.GetValue<string>() == "none"
                && config["configured"]?.GetValue<bool>() == false && config["api"]?["hasKey"]?.GetValue<bool>() == false);
            Check("default-model-capabilities-off", config["capabilities"]?["chat"]?.GetValue<bool>() == false
                && config["capabilities"]?["vision"]?.GetValue<bool>() == false);
            JsonNode proactive = await client.RequestAsync("/api/proactive-policy", cancellationToken: deadline.Token).ConfigureAwait(false);
            Check("proactive-default-off", proactive["policy"]?["enabled"]?.GetValue<bool>() == false);
            await client.StopAsync().ConfigureAwait(false);
            using var exited = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            await owned.WaitForExitAsync(exited.Token).ConfigureAwait(false);
            Check("owned-child-exited-cleanly", owned.HasExited && owned.ExitCode == 0);
            Check("client-no-longer-running", !client.IsRunning);
            Check("owned-state-file-removed", !File.Exists(stateFile));
            completed = true;
        }
        catch { checks["completed-without-exception"] = false; }
        finally
        {
            if (client != null) { try { await client.StopAsync().ConfigureAwait(false); } catch { completed = false; } }
            owned?.Dispose();
            foreach (var item in previous) Environment.SetEnvironmentVariable(item.Key, item.Value);
            for (int attempt = 0; attempt < 5; attempt++)
            {
                try { if (Directory.Exists(root)) Directory.Delete(root, true); cleanupSucceeded = !Directory.Exists(root); break; }
                catch { await Task.Delay(100).ConfigureAwait(false); }
            }
        }
        checks["temporary-root-cleaned"] = cleanupSucceeded;
        bool passed = completed && cleanupSucceeded;
        Console.WriteLine(JsonSerializer.Serialize(new { passed, checks, ownedJobAttached = jobAttached,
            guiStarted = false, loginPerformed = false, modelRequests = false, desktopCaptured = false,
            providerCredentialsRead = false, defaultUserDataRead = false, normalDesktopValidated = false }, new JsonSerializerOptions { WriteIndented = true }));
        return passed ? 0 : 1;
    }

    private static bool PrivateAccessList(FileSystemInfo item, bool requireProtected)
    {
        FileSystemSecurity acl = item is DirectoryInfo directory
            ? directory.GetAccessControl(AccessControlSections.Access)
            : ((FileInfo)item).GetAccessControl(AccessControlSections.Access);
        if (requireProtected && !acl.AreAccessRulesProtected) return false;
        SecurityIdentifier? current = WindowsIdentity.GetCurrent().User;
        if (current == null) return false;
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        bool ownAllow = false;
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            if (rule.AccessControlType != AccessControlType.Allow) continue;
            if (!rule.IdentityReference.Equals(current) && !rule.IdentityReference.Equals(system)) return false;
            ownAllow |= rule.IdentityReference.Equals(current) && (rule.FileSystemRights & FileSystemRights.ReadData) != 0;
        }
        return ownAllow;
    }
}
