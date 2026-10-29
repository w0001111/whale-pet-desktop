using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace WhalePet.Windows;

public sealed record ChatMessage(string role, string content);

/// Owns one private loopback service, never another instance's token or process.
public sealed class ServiceClient : IAsyncDisposable
{
    public string AppDataRoot { get; }
    public string DataRoot => Path.Combine(AppDataRoot, "data");
    public string ResourceRoot { get; }
    public bool IsSyntheticTestRoot { get; }
    public bool IsRunning => _process is { HasExited: false } && _baseUri != null;
    public Task ReadyTask => _ready.Task;
    private readonly TaskCompletionSource _ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly HttpClient _http;
    private readonly CancellationTokenSource _stop = new();
    private Process? _process;
    private IDisposable? _job;
    private Uri? _baseUri;
    private string? _token;
    private int _started, _stopping;

    public ServiceClient(string? applicationRoot = null, string? resourceRoot = null, bool syntheticTest = false)
    {
        AppDataRoot = Path.GetFullPath(applicationRoot ?? ResolveApplicationRoot());
        ResourceRoot = Path.GetFullPath(resourceRoot ?? Path.Combine(AppContext.BaseDirectory, "service"));
        IsSyntheticTestRoot = syntheticTest;
        _http = new HttpClient(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false, UseCookies = false })
        { Timeout = TimeSpan.FromSeconds(125), MaxResponseContentBufferSize = 4 * 1024 * 1024 };
    }

    public static string ResolveApplicationRoot()
    {
        string? value = Environment.GetEnvironmentVariable("WHALE_PET_DATA_DIR");
        return string.IsNullOrWhiteSpace(value) ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WhalePet") : Path.GetFullPath(value);
    }

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        if (IsSyntheticTestRoot) throw new InvalidOperationException("合成 WPF 探针不允许启动模型服务。");
        if (Interlocked.Exchange(ref _started, 1) != 0) { await ReadyTask.WaitAsync(cancellationToken); return; }
        try
        {
            string node = Environment.GetEnvironmentVariable("NODE_BINARY") ?? Path.Combine(AppContext.BaseDirectory, "runtime", "bin", "node.exe");
            string entry = Path.Combine(ResourceRoot, "service.mjs");
            if (!File.Exists(node) || !File.Exists(entry)) throw new InvalidOperationException("本机运行时不完整；请重新解压完整发行包。离线桌宠仍可使用。");
            Directory.CreateDirectory(DataRoot);
            var info = new ProcessStartInfo(node) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = AppDataRoot,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardInputEncoding = new UTF8Encoding(false) };
            info.ArgumentList.Add(entry);
            info.Environment.Clear();
            foreach (string key in new[] { "PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "LANG", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY" })
            {
                string? inherited = Environment.GetEnvironmentVariable(key);
                if (!string.IsNullOrEmpty(inherited)) info.Environment[key] = inherited;
            }
            info.Environment["WHALE_PET_DATA_DIR"] = AppDataRoot;
            info.Environment["WHALE_PET_RESOURCE_DIR"] = ResourceRoot;
            info.Environment["WHALE_PET_CODEX_BINARY"] = Environment.GetEnvironmentVariable("WHALE_PET_CODEX_BINARY") ?? Path.Combine(AppContext.BaseDirectory, "runtime", "codex.exe");
            info.Environment["WHALE_PET_PORT"] = "0";
            info.Environment["WHALE_PET_PARENT_IPC"] = "1";
            _process = new Process { StartInfo = info, EnableRaisingEvents = true };
            _process.OutputDataReceived += (_, _) => { }; _process.ErrorDataReceived += (_, _) => { };
            if (!_process.Start()) throw new InvalidOperationException("本机服务未能启动。");
            _process.BeginOutputReadLine(); _process.BeginErrorReadLine();
            _job = NativeMethods.OwnChild(_process);
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _stop.Token);
            linked.CancelAfter(TimeSpan.FromSeconds(90));
            string stateFile = Path.Combine(DataRoot, "service.json");
            while (true)
            {
                linked.Token.ThrowIfCancellationRequested();
                if (_process.HasExited) throw new InvalidOperationException("本机服务已退出；桌宠可继续离线使用。");
                try
                {
                    if (File.Exists(stateFile) && new FileInfo(stateFile).Length <= 65536)
                    {
                        JsonNode? state = JsonNode.Parse(await File.ReadAllTextAsync(stateFile, linked.Token));
                        int pid = state?["pid"]?.GetValue<int>() ?? 0;
                        int port = state?["port"]?.GetValue<int>() ?? 0;
                        string? token = state?["token"]?.GetValue<string>();
                        string? raw = state?["baseURL"]?.GetValue<string>();
                        if (pid == _process.Id && port is > 0 and <= 65535 && token is { Length: >= 24 and <= 512 }
                            && raw == $"http://127.0.0.1:{port}")
                        { _baseUri = new Uri(raw + "/"); _token = token; break; }
                    }
                }
                catch (Exception error) when (error is IOException or JsonException or InvalidOperationException) { }
                await Task.Delay(100, linked.Token);
            }
            _ready.TrySetResult();
        }
        catch (Exception error)
        {
            _ready.TrySetException(new InvalidOperationException("本机服务尚未连接；可以继续离线玩桌宠。", error));
            throw;
        }
    }

    internal static bool SafeRoute(string route)
    {
        if (!route.StartsWith('/') || route.StartsWith("//", StringComparison.Ordinal) || route.Contains('\\')) return false;
        foreach (char character in route) if (char.IsControl(character)) return false;
        return true;
    }

    public Task<JsonNode> RequestAsync(string route, object? body = null, CancellationToken cancellationToken = default) =>
        RequestAsync(route, body == null ? HttpMethod.Get : HttpMethod.Post, body == null ? null : JsonSerializer.SerializeToNode(body), cancellationToken);

    public async Task<JsonNode> RequestAsync(string route, HttpMethod method, JsonNode? body, CancellationToken cancellationToken = default)
    {
        if (!SafeRoute(route)) throw new ArgumentException("只接受本机服务的相对路径。", nameof(route));
        await ReadyTask.WaitAsync(cancellationToken);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _stop.Token);
        if (_baseUri == null || _token == null || !IsRunning) throw new InvalidOperationException("本机服务当前未连接。");
        Uri uri = new(_baseUri, route);
        if (uri.Host != "127.0.0.1" || uri.Port != _baseUri.Port || uri.Scheme != "http") throw new InvalidOperationException("已拒绝非本机请求。");
        using var outgoing = new HttpRequestMessage(method, uri);
        outgoing.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
        outgoing.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (body != null) outgoing.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        using HttpResponseMessage response = await _http.SendAsync(outgoing, HttpCompletionOption.ResponseContentRead, linked.Token);
        string text = await response.Content.ReadAsStringAsync(linked.Token);
        JsonNode? result;
        try { result = JsonNode.Parse(text); } catch { throw new InvalidOperationException("本机服务没有返回有效数据。"); }
        if (!response.IsSuccessStatusCode)
        {
            string message = result?["error"] is JsonValue value && value.TryGetValue<string>(out string? error) ? error : result?["error"]?["message"]?.GetValue<string>() ?? "本机操作未完成，请稍后重试。";
            throw new InvalidOperationException(message);
        }
        return result ?? new JsonObject();
    }

    public Task<JsonNode> SendChatAsync(string text, IEnumerable<ChatMessage>? history = null, CancellationToken cancellationToken = default) =>
        RequestAsync("/api/chat", new { message = text, history = history ?? Array.Empty<ChatMessage>(), appInfoOptIn = false }, cancellationToken);

    public async Task StopAsync()
    {
        if (Interlocked.Exchange(ref _stopping, 1) != 0) return;
        _stop.Cancel();
        try
        {
            if (_process is { HasExited: false })
            {
                try { await _process.StandardInput.WriteLineAsync("{\"type\":\"shutdown\"}").ConfigureAwait(false); await _process.StandardInput.FlushAsync().ConfigureAwait(false); } catch { }
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
                try { await _process.WaitForExitAsync(timeout.Token).ConfigureAwait(false); }
                catch (OperationCanceledException) { try { _process.Kill(entireProcessTree: true); } catch { } }
            }
        }
        finally { _job?.Dispose(); _job = null; _process?.Dispose(); _process = null; _http.Dispose(); _token = null; }
    }
    public async ValueTask DisposeAsync() { await StopAsync().ConfigureAwait(false); _stop.Dispose(); }
}
