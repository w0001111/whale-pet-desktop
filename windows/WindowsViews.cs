using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace WhalePet.Windows;

/// <summary>Ordinary WPF views. All HTTP uses the owned local ServiceClient.</summary>
public sealed class WindowsViews
{
    private readonly ServiceClient service;
    private readonly PetWindow owner;
    private readonly Dispatcher dispatcher;
    private readonly CancellationTokenSource lifetime = new();
    private readonly List<SavedMessage> messages = new();
    private readonly List<ViewWindow> windows = new();
    private readonly string chatFile;
    private bool historyAvailable;
    private bool sending;
    private bool stopped;
    private ChatView? chat;
    private SetupView? setup;
    private TaskView? tasks;
    private MemoryView? memory;
    private ReminderView? reminders;
    private UsageView? usage;
    private CompanionView? companion;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public WindowsViews(ServiceClient service, PetWindow owner)
    {
        this.service = service;
        this.owner = owner;
        dispatcher = owner.Dispatcher;
        chatFile = Path.Combine(service.DataRoot, "chat.json");
        historyAvailable = service.IsSyntheticTestRoot || LoadHistory();
    }

    public bool HasVisibleWindows => dispatcher.CheckAccess()
        ? windows.Any(window => window.IsVisible)
        : dispatcher.Invoke(() => windows.Any(window => window.IsVisible));

    public void ShowChat() => OnUi(() => Show(chat ??= Add(new ChatView(this))));
    public void ShowSetup() => OnUi(() => Show(setup ??= Add(new SetupView(this))));
    public void ShowTasks() => OnUi(() => Show(tasks ??= Add(new TaskView(this))));
    public void ShowMemory() => OnUi(() => Show(memory ??= Add(new MemoryView(this))));
    public void ShowReminders() => OnUi(() => Show(reminders ??= Add(new ReminderView(this))));
    public void ShowUsage() => OnUi(() => Show(usage ??= Add(new UsageView(this))));
    public void ShowProactiveSettings() => OnUi(() => Show(companion ??= Add(new CompanionView(this))));

    private T Add<T>(T view) where T : ViewWindow { windows.Add(view); return view; }
    private void OnUi(Action action)
    {
        if (stopped) return;
        if (dispatcher.CheckAccess()) action();
        else dispatcher.BeginInvoke(action);
    }
    private static void Show(ViewWindow view)
    {
        view.Show();
        if (view.WindowState == WindowState.Minimized) view.WindowState = WindowState.Normal;
        view.Activate();
        _ = view.RefreshSafelyAsync();
    }

    /// <summary>Shared by the full chat and the pet's inline bubble reply.</summary>
    public async Task<JsonNode> SendInlineReplyAsync(string text)
    {
        if (!dispatcher.CheckAccess())
            return await dispatcher.InvokeAsync(() => SendInlineReplyAsync(text)).Task.Unwrap();
        text = text.Trim();
        if (text.Length == 0 || text.Length > 4000) throw new ViewInputException("请输入 1—4000 字的消息。");
        if (stopped) throw new OperationCanceledException();
        if (sending || owner.ConversationBusy) throw new ViewInputException("正在处理上一条消息，请稍后发送。");
        if (!historyAvailable) throw new ViewInputException("聊天记录未能读取，原文件已保留。请先检查本机数据目录，避免覆盖旧记录。");
        sending = true;
        owner.ConversationBusy = true;
        var history = new List<ChatMessage>();
        var historyCharacters = text.Length;
        foreach (var item in messages.Where(item => (item.role is "user" or "assistant") && item.source != "local").TakeLast(16).Reverse())
        {
            var content = item.content.Length > 6000 ? item.content[..6000] : item.content;
            if (historyCharacters + content.Length > 24000) continue;
            history.Add(new ChatMessage(item.role, content)); historyCharacters += content.Length;
        }
        history.Reverse();
        var recent = messages.Where(item => item.messageId != null && item.model != "local-reminder")
            .TakeLast(3).Select(item => new
            {
                id = item.messageId,
                at = item.time,
                content = item.content.Length > 600 ? item.content[..600] : item.content,
                source = item.source is "api" or "local" ? item.source : "codex"
            }).ToArray();
        var old = messages.ToList();
        try
        {
            var userRecord = new SavedMessage("user", text, Now());
            messages.Add(userRecord);
            if (!SaveHistory())
            {
                messages.Clear(); messages.AddRange(old);
                throw new ViewInputException("消息尚未保存，未发送。请检查本机数据目录的读写权限。");
            }
            chat?.Redraw();
            var result = await service.RequestAsync("/api/chat", new
            {
                message = text, history, recentProactive = recent, appInfoOptIn = false
            }, lifetime.Token);
            var reply = Text(result, "text");
            if (string.IsNullOrWhiteSpace(reply)) throw new ViewInputException("本次没有取得模型回复，请检查连接设置后重试。");
            if (Text(result, "source") == "local")
            {
                // Local reminders/settings are not silently imported as an
                // orphan user message in a later model conversation.
                var index = messages.FindIndex(item => ReferenceEquals(item, userRecord));
                if (index >= 0) messages[index] = userRecord with { source = "local" };
            }
            messages.Add(new SavedMessage("assistant", reply, Now(), TextOrNull(result, "model"), TextOrNull(result, "source")));
            if (!SaveHistory()) chat?.SetStatus("回复已取得，但聊天记录未能写入；请检查本机存储。", true);
            chat?.Redraw();
            return result;
        }
        finally
        {
            sending = false;
            owner.ConversationBusy = false;
        }
    }

    /// <summary>The core ACKs a durable local event only after this returns true.</summary>
    public bool RecordIncoming(JsonNode response, string? messageId = null)
    {
        if (!dispatcher.CheckAccess()) return dispatcher.Invoke(() => RecordIncoming(response, messageId));
        if (stopped || !historyAvailable) return false;
        var text = Text(response, "text");
        if (string.IsNullOrWhiteSpace(text) || text.Length > 20000 || messageId?.Length > 200) return false;
        if (messageId != null && messages.Any(item => item.messageId == messageId)) return true;
        var old = messages.ToList();
        var at = DateTimeOffset.TryParse(Text(response, "at"), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var parsed)
            ? Timestamp(parsed) : Now();
        messages.Add(new SavedMessage("assistant", text, at, TextOrNull(response, "model"), TextOrNull(response, "source") ?? "local",
            messageId, TextOrNull(response, "reminderId"), TextOrNull(response, "kind")));
        if (!SaveHistory()) { messages.Clear(); messages.AddRange(old); return false; }
        chat?.Redraw();
        return true;
    }

    public void Shutdown()
    {
        if (!dispatcher.CheckAccess()) { dispatcher.Invoke(Shutdown); return; }
        if (stopped) return;
        stopped = true;
        lifetime.Cancel();
        owner.ConversationHasDraft = false;
        foreach (var view in windows.ToArray()) view.ClosePermanently();
        windows.Clear();
    }

    private bool LoadHistory()
    {
        try
        {
            if ((Directory.Exists(service.AppDataRoot) && IsReparsePoint(service.AppDataRoot))
                || (Directory.Exists(service.DataRoot) && IsReparsePoint(service.DataRoot))) return false;
            if (!File.Exists(chatFile)) return true;
            if (IsReparsePoint(chatFile) || new FileInfo(chatFile).Length > 2 * 1024 * 1024) return false;
            var loaded = JsonSerializer.Deserialize<List<SavedMessage>>(File.ReadAllText(chatFile), JsonOptions);
            if (loaded == null || loaded.Any(item => item.role is not ("user" or "assistant" or "notice")
                || item.content == null || item.content.Length > 20000 || item.time == null)) return false;
            messages.AddRange(loaded.TakeLast(300));
            return true;
        }
        catch { return false; }
    }

    private bool SaveHistory()
    {
        string? temporary = null;
        try
        {
            Directory.CreateDirectory(service.DataRoot);
            if (IsReparsePoint(service.AppDataRoot) || IsReparsePoint(service.DataRoot) || (File.Exists(chatFile) && IsReparsePoint(chatFile))) return false;
            var limited = messages.TakeLast(300).ToList();
            var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(limited, JsonOptions));
            if (bytes.Length > 2 * 1024 * 1024) return false;
            temporary = Path.Combine(service.DataRoot, ".chat-" + Guid.NewGuid().ToString("N") + ".tmp");
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 8192, FileOptions.WriteThrough))
            { stream.Write(bytes); stream.Flush(true); }
            File.Move(temporary, chatFile, true);
            temporary = null;
            messages.Clear(); messages.AddRange(limited);
            return true;
        }
        catch { return false; }
        finally { if (temporary != null) { try { File.Delete(temporary); } catch { } } }
    }

    private async Task NewChatAsync()
    {
        if (sending || owner.ConversationBusy) throw new ViewInputException("请等当前回复结束后再开始新对话。");
        if (!historyAvailable) throw new ViewInputException("旧聊天记录未能读取，原文件会保留，请先检查存储。");
        await service.RequestAsync("/api/chat/new", new { }, lifetime.Token);
        messages.Clear();
        if (!SaveHistory()) { historyAvailable = false; throw new ViewInputException("服务端已新建对话，但本机聊天清空未完成；请检查存储后重试。"); }
        chat?.ClearDraft();
        chat?.Redraw();
    }

    private static bool IsReparsePoint(string path) => (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;
    private static string Timestamp(DateTimeOffset time) => time.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
    private static string Now() => Timestamp(DateTimeOffset.UtcNow);
    private static JsonNode? At(JsonNode? node, string path)
    {
        foreach (var key in path.Split('.')) { if (node is not JsonObject obj) return null; node = obj[key]; }
        return node;
    }
    private static string Text(JsonNode? node, string path, string fallback = "")
    {
        try { return At(node, path)?.GetValue<string>() ?? fallback; } catch { return fallback; }
    }
    private static string? TextOrNull(JsonNode? node, string path) { var value = Text(node, path); return value.Length == 0 ? null : value; }
    private static bool Flag(JsonNode? node, string path, bool fallback = false)
    {
        try { return At(node, path)?.GetValue<bool>() ?? fallback; } catch { return fallback; }
    }
    private static long Number(JsonNode? node, string path, long fallback = 0)
    {
        try { return At(node, path)?.GetValue<long>() ?? fallback; } catch { return fallback; }
    }
    private static IEnumerable<JsonNode> Items(JsonNode? node, string path)
        => At(node, path) is JsonArray array ? array.Where(item => item != null).Select(item => item!) : Enumerable.Empty<JsonNode>();
    private static long Integer(TextBox input, long minimum, long maximum, string label)
    {
        if (!long.TryParse(input.Text.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var result) || result < minimum || result > maximum)
            throw new ViewInputException($"{label}应为 {minimum}—{maximum} 范围内的整数。");
        return result;
    }
    internal static bool TryOfficialAuthorizationUri(string value, out Uri? uri)
    {
        uri = null;
        if (value.Any(char.IsControl) || !Uri.TryCreate(value, UriKind.Absolute, out var parsed)
            || parsed.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(parsed.UserInfo)
            || (!parsed.IsDefaultPort && parsed.Port != 443)
            || !new[] { "auth.openai.com", "chatgpt.com", "auth0.openai.com" }.Contains(parsed.Host, StringComparer.OrdinalIgnoreCase)) return false;
        uri = parsed;
        return true;
    }

    internal IReadOnlyDictionary<string, bool> BuildSyntheticViewsForTest(string? snapshotDirectory = null)
    {
        if (!dispatcher.CheckAccess()) throw new InvalidOperationException("Synthetic WPF checks require the UI dispatcher.");
        if (!service.IsSyntheticTestRoot) throw new InvalidOperationException("Synthetic WPF checks require an explicitly isolated test ServiceClient.");
        chat ??= Add(new ChatView(this)); setup ??= Add(new SetupView(this)); tasks ??= Add(new TaskView(this));
        memory ??= Add(new MemoryView(this)); reminders ??= Add(new ReminderView(this)); usage ??= Add(new UsageView(this));
        companion ??= Add(new CompanionView(this));
        setup.ApplySynthetic(new JsonObject { ["mode"] = "api", ["api"] = new JsonObject { ["hasKey"] = true, ["apiKey"] = "SYNTHETIC-DO-NOT-DISPLAY", ["baseURL"] = "https://example.com/v1", ["format"] = "responses" } });
        if (snapshotDirectory != null)
        {
            // These are control renders, not screenshots. Only these fixed
            // messages enter the render; no user window or desktop is captured.
            var saved = messages.ToList();
            try
            {
                messages.Clear();
                messages.Add(new SavedMessage("user", "合成测试：今天想先完成一件小事。", "2030-01-01T01:00:00Z"));
                messages.Add(new SavedMessage("assistant", "那就从最容易开始的一步做起吧，我在旁边陪你。🐋", "2030-01-01T01:00:01Z", "synthetic-model", "api"));
                chat.ClearDraft(); chat.Redraw();
                Directory.CreateDirectory(snapshotDirectory);
                RenderSyntheticWindow(chat, Path.Combine(snapshotDirectory, "chat.png"));
                RenderSyntheticWindow(setup, Path.Combine(snapshotDirectory, "setup.png"));
            }
            finally { messages.Clear(); messages.AddRange(saved); chat.Redraw(); }
        }
        return new Dictionary<string, bool>
        {
            ["sevenViewsConstructedWithoutNetwork"] = windows.Count == 7,
            ["keyNeverPrefilledFromGet"] = setup.KeyIsEmpty,
            ["officialHttpsAccepted"] = TryOfficialAuthorizationUri("https://auth.openai.com/authorize?synthetic=1", out _),
            ["httpRejected"] = !TryOfficialAuthorizationUri("http://auth.openai.com/", out _),
            ["lookalikeRejected"] = !TryOfficialAuthorizationUri("https://auth.openai.com.example.org/", out _),
            ["userinfoRejected"] = !TryOfficialAuthorizationUri("https://example.org@auth.openai.com/", out _),
            ["foreignPortRejected"] = !TryOfficialAuthorizationUri("https://auth.openai.com:444/", out _),
            ["modelOutputIsPlainText"] = chat.OutputIsPlainText,
            ["windowsContextUnsupported"] = true
        };
    }

    private static void RenderSyntheticWindow(Window window, string file)
    {
        if (window.Content is not FrameworkElement content) throw new InvalidOperationException("Synthetic view content is missing.");
        var width = Math.Max(480, window.Width); var height = Math.Max(380, window.Height);
        content.Measure(new Size(width, height)); content.Arrange(new Rect(0, 0, width, height)); content.UpdateLayout();
        var visual = new DrawingVisual();
        using (var drawing = visual.RenderOpen())
        {
            drawing.DrawRectangle(window.Background ?? Brushes.White, null, new Rect(0, 0, width, height));
            drawing.DrawRectangle(new VisualBrush(content), null, new Rect(0, 0, width, height));
        }
        var bitmap = new RenderTargetBitmap((int)Math.Ceiling(width), (int)Math.Ceiling(height), 96, 96, PixelFormats.Pbgra32);
        bitmap.Render(visual);
        var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using var stream = new FileStream(file, FileMode.Create, FileAccess.Write, FileShare.None); encoder.Save(stream);
    }

    private sealed record SavedMessage(string role, string content, string time, string? model = null, string? source = null,
        string? messageId = null, string? reminderId = null, string? kind = null);
    private sealed class ViewInputException(string message) : Exception(message) { }
    private sealed record Row(string Id, string Label, JsonNode Value) { public override string ToString() => Label; }

    private abstract class ViewWindow : Window
    {
        protected readonly WindowsViews Host;
        protected readonly StackPanel Body = new() { Margin = new Thickness(18) };
        protected readonly TextBlock Status = new() { Margin = new Thickness(18, 8, 18, 14), TextWrapping = TextWrapping.Wrap };
        private readonly List<(Button Button, Func<bool>? Condition)> actions = new();
        private readonly List<Control> editables = new();
        private bool forceClose;
        protected bool Busy { get; private set; }

        protected ViewWindow(WindowsViews host, string title, double width = 660, double height = 680)
        {
            Host = host; Title = title; Width = width; Height = height; MinWidth = 480; MinHeight = 380;
            FontFamily = new FontFamily("Microsoft YaHei UI"); FontSize = 14;
            Background = new SolidColorBrush(Color.FromRgb(247, 249, 252));
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            var root = new DockPanel(); DockPanel.SetDock(Status, Dock.Bottom); root.Children.Add(Status);
            root.Children.Add(new ScrollViewer { Content = Body, VerticalScrollBarVisibility = ScrollBarVisibility.Auto }); Content = root;
            Closing += (_, e) => { if (!forceClose) { e.Cancel = true; Hide(); } };
        }
        protected TextBlock Note(string value)
        {
            var note = new TextBlock { Text = value, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 12), Foreground = Brushes.DimGray };
            Body.Children.Add(note); return note;
        }
        protected void Heading(string text) => Body.Children.Add(new TextBlock { Text = text, FontSize = 17, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 16, 0, 8) });
        protected TextBox Input(string label, string value = "", bool multiline = false)
        {
            Body.Children.Add(new TextBlock { Text = label, Margin = new Thickness(0, 7, 0, 4) });
            var input = new TextBox { Text = value, Padding = new Thickness(7), MinHeight = 32, AcceptsReturn = multiline, TextWrapping = multiline ? TextWrapping.Wrap : TextWrapping.NoWrap };
            if (multiline) input.MinHeight = 82;
            Body.Children.Add(input); editables.Add(input); return input;
        }
        protected ComboBox Choice(string label, params string[] items)
        {
            Body.Children.Add(new TextBlock { Text = label, Margin = new Thickness(0, 7, 0, 4) });
            var control = new ComboBox { ItemsSource = items, SelectedIndex = 0, MinHeight = 32, Padding = new Thickness(5) };
            Body.Children.Add(control); editables.Add(control); return control;
        }
        protected CheckBox Toggle(string label, bool value = false)
        {
            var control = new CheckBox { Content = label, IsChecked = value, Margin = new Thickness(0, 9, 0, 7) };
            Body.Children.Add(control); editables.Add(control); return control;
        }
        protected Button Action(string label, Func<Task> operation, Func<bool>? condition = null)
        {
            var button = new Button { Content = label, Margin = new Thickness(0, 7, 0, 3), Padding = new Thickness(9, 6, 9, 6), HorizontalAlignment = HorizontalAlignment.Left, MinWidth = 110 };
            actions.Add((button, condition)); button.Click += async (_, _) => await Run(operation);
            Body.Children.Add(button); UpdateButtons(); return button;
        }
        protected TextBox Output(double height = 190)
        {
            var output = new TextBox { IsReadOnly = true, AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Height = height, Margin = new Thickness(0, 9, 0, 6), Padding = new Thickness(9) };
            Body.Children.Add(output); return output;
        }
        protected ListBox List(double height = 170, bool multi = false)
        {
            var list = new ListBox { Height = height, Margin = new Thickness(0, 8, 0, 4), SelectionMode = multi ? SelectionMode.Multiple : SelectionMode.Single };
            Body.Children.Add(list); editables.Add(list); return list;
        }
        protected void RegisterEditable(Control control) => editables.Add(control);
        protected void UpdateButtons()
        {
            foreach (var (button, condition) in actions) button.IsEnabled = !Busy && !Host.stopped && (condition?.Invoke() ?? true);
        }
        public void SetStatus(string value, bool error = false) { Status.Text = value; Status.Foreground = error ? Brushes.Firebrick : Brushes.DimGray; }
        protected async Task Run(Func<Task> operation)
        {
            if (Busy || Host.stopped) return;
            Busy = true; UpdateButtons(); foreach (var control in editables) control.IsEnabled = false;
            try { await operation(); }
            catch (OperationCanceledException) { if (!Host.stopped) SetStatus("操作已取消，未自动重试。", true); }
            catch (ViewInputException error) { SetStatus(error.Message, true); }
            catch { SetStatus("操作未完成。请检查本机服务与已保存连接；敏感的上游错误内容不会在这里显示。", true); }
            finally { Busy = false; foreach (var control in editables) control.IsEnabled = true; UpdateButtons(); }
        }
        public Task RefreshSafelyAsync() => Run(RefreshAsync);
        protected virtual Task RefreshAsync() => Task.CompletedTask;
        protected Task<JsonNode> Get(string route) => Host.service.RequestAsync(route, null, Host.lifetime.Token);
        protected Task<JsonNode> Post(string route, object body) => Host.service.RequestAsync(route, body, Host.lifetime.Token);
        public virtual void ClosePermanently() { forceClose = true; Close(); }
    }

    private sealed class ChatView : ViewWindow
    {
        private readonly TextBox transcript;
        private readonly TextBox input;
        public bool OutputIsPlainText => transcript.IsReadOnly && transcript is TextBox;
        public ChatView(WindowsViews host) : base(host, "大肥鱼 · 聊天", 740, 720)
        {
            var intro = Note("截图与前台应用信息在 Windows 首版尚未支持，保持关闭。聊天只发送文字、近期对话、已保存偏好和记忆。");
            var setupButton = Action("AI 连接设置", () => { Host.ShowSetup(); return Task.CompletedTask; });
            transcript = Output(340);
            input = Input("消息（Enter 发送，Shift+Enter 换行）", multiline: true);
            input.TextChanged += (_, _) => Host.owner.ConversationHasDraft = IsVisible && !string.IsNullOrWhiteSpace(input.Text);
            IsVisibleChanged += (_, _) => Host.owner.ConversationHasDraft = IsVisible && !string.IsNullOrWhiteSpace(input.Text);
            input.PreviewKeyDown += async (_, e) =>
            {
                if (e.Key == Key.Enter && (Keyboard.Modifiers & ModifierKeys.Shift) == 0) { e.Handled = true; await Run(Send); }
            };
            var sendButton = Action("发送", Send, () => !Host.sending && Host.historyAvailable);
            var bubbleButton = Action("收起到气泡", () =>
            {
                var last = Host.messages.LastOrDefault(item => item.role == "assistant");
                if (last != null) Host.owner.ShowBubble(last.content, last.source ?? "local");
                Hide(); return Task.CompletedTask;
            });
            var newButton = Action("开始新对话（保留记忆）", async () => { await Host.NewChatAsync(); SetStatus("已开始新对话；之前的聊天由本机后端归档，长期记忆保留。"); }, () => !Host.sending);
            var memoryButton = Action("长期记忆", () => { Host.ShowMemory(); return Task.CompletedTask; });
            // Keep the composer visible while only the transcript scrolls.
            Body.Children.Clear();
            if (Status.Parent is Panel previous) previous.Children.Remove(Status);
            var layout = new DockPanel();
            DockPanel.SetDock(Status, Dock.Bottom); layout.Children.Add(Status);
            var compose = new DockPanel { Margin = new Thickness(18, 5, 18, 4) };
            var composeLabel = new TextBlock { Text = "消息（Enter 发送，Shift+Enter 换行）", Margin = new Thickness(0, 0, 0, 5) };
            DockPanel.SetDock(composeLabel, Dock.Top); compose.Children.Add(composeLabel);
            DockPanel.SetDock(sendButton, Dock.Right); sendButton.Margin = new Thickness(10, 0, 0, 0); sendButton.VerticalAlignment = VerticalAlignment.Bottom;
            compose.Children.Add(sendButton); input.VerticalScrollBarVisibility = ScrollBarVisibility.Auto; input.Height = 88; compose.Children.Add(input);
            DockPanel.SetDock(compose, Dock.Bottom); layout.Children.Add(compose);
            var header = new StackPanel { Margin = new Thickness(18, 14, 18, 0) }; header.Children.Add(intro);
            var toolbar = new WrapPanel();
            foreach (var button in new[] { setupButton, memoryButton, bubbleButton, newButton }) { button.Margin = new Thickness(0, 0, 8, 7); toolbar.Children.Add(button); }
            header.Children.Add(toolbar); DockPanel.SetDock(header, Dock.Top); layout.Children.Add(header);
            transcript.Height = double.NaN; transcript.Margin = new Thickness(18, 4, 18, 3); layout.Children.Add(transcript);
            Content = layout; MinHeight = 540;
            Redraw();
        }
        private async Task Send()
        {
            var text = input.Text;
            SetStatus("正在发送这条文字消息；没有附带截图或前台窗口信息…");
            var response = await Host.SendInlineReplyAsync(text);
            ClearDraft(); Host.owner.ReceiveChatResponse(response);
            SetStatus(Text(response, "source") == "local" ? "本机操作已完成，没有调用模型。" : "已收到回复。Windows 首版没有发送截图或前台窗口信息。");
        }
        public void ClearDraft() { input.Clear(); Host.owner.ConversationHasDraft = false; }
        public void Redraw()
        {
            transcript.Text = Host.messages.Count == 0 ? "你来啦。想聊天就发一句；未配置 AI 时，本地提醒、待办和明确的“记住：……”仍可使用。🐋" : string.Join("\n\n", Host.messages.Select(item =>
                (item.role == "user" ? "你" : item.role == "assistant" ? "大肥鱼" : "本机提示") + " · " + LocalTime(item.time) + "\n" + item.content));
            if (!Host.historyAvailable) SetStatus("聊天记录未能读取，原文件已保留；当前不会覆盖它。请检查存储后重启应用。", true);
            if (IsVisible) Dispatcher.BeginInvoke(new Action(() => { transcript.ScrollToEnd(); }), DispatcherPriority.Background);
        }
        protected override Task RefreshAsync() { Redraw(); return Task.CompletedTask; }
    }

    private sealed class SetupView : ViewWindow
    {
        private readonly ComboBox mode;
        private readonly ComboBox format;
        private readonly TextBox model;
        private readonly TextBox baseUrl;
        private readonly TextBox cliPath;
        private readonly PasswordBox key;
        private readonly TextBlock keyNote;
        private readonly TextBlock codexNote;
        private readonly DispatcherTimer timer;
        private bool hasKey;
        private bool configured;
        private bool loginPending;
        private bool dirty;
        private bool applying;
        private string? loginId;
        private string? openedUrl;
        private bool mayOpenAuthorization;
        public bool KeyIsEmpty => key.Password.Length == 0;
        public SetupView(WindowsViews host) : base(host, "大肥鱼 · AI 连接设置", 660, 820)
        {
            Note("先保存，再按需测试。保存、刷新和账号登录不会调用模型；“测试连接”会消耗一次小请求。API Key 在本机受限目录中保存，不会从读取接口填回输入框。");
            mode = Choice("连接方式", "离线桌宠", "Codex 账号（隔离只读受限模式·实验）", "API 兼容服务");
            model = Input("模型（Codex 可留空使用默认；API 必填）");
            model.MaxLength = 120;
            format = Choice("API 协议", "Responses", "Chat Completions");
            baseUrl = Input("API Base URL（远程必须 HTTPS）", "https://api.openai.com/v1");
            baseUrl.MaxLength = 2048;
            Body.Children.Add(new TextBlock { Text = "API Key（安全输入框）", Margin = new Thickness(0, 8, 0, 4) });
            key = new PasswordBox { Padding = new Thickness(7), MinHeight = 32, MaxLength = 4096 }; Body.Children.Add(key); RegisterEditable(key);
            keyNote = Note("尚未保存 Key。更换不同服务地址时，请重新填写该服务自己的 Key。");
            cliPath = Input("Codex CLI 路径（发行包默认自动选择，通常留空）");
            cliPath.MaxLength = 2048;
            codexNote = Note("Codex 使用本应用自己的独立账号目录，不导入其他应用登录。Windows 首版仅文字，不支持截图。");
            Action("保存连接设置（不调用模型）", Save);
            Action("先离线使用", async () => { Apply(await Post("/api/config", new { mode = "none" })); SetStatus("已保存为离线桌宠。"); });
            Action("刷新状态（不调用模型）", RefreshAsync);
            Action("测试已保存连接（会消耗额度）", async () =>
            {
                var response = await Post("/api/config/test", new { });
                SetStatus(Flag(response, "ok") ? "连接测试成功；文字成功不代表模型支持图像。" : "连接测试未完成，请检查设置。");
            }, () => configured && !dirty);
            Action("删除已保存的 API Key", async () => { Apply(await Post("/api/config", new { api = new { clearKey = true } })); key.Clear(); SetStatus("已删除本应用保存的 API Key。"); }, () => hasKey);
            Action("在官方页面登录 Codex", BeginLogin, () => !loginPending);
            Action("取消本次登录", async () => { await Post("/api/codex/login/cancel", new { loginId }); loginPending = false; mayOpenAuthorization = false; await RefreshAsync(); }, () => loginPending);
            Action("退出本应用的 Codex 账号", async () => { await Post("/api/codex/logout", new { }); mayOpenAuthorization = false; await RefreshAsync(); SetStatus("本应用账号已退出；其他 Codex 应用的账号没有被读取或修改。"); });
            mode.SelectionChanged += (_, _) => { if (!applying) model.Clear(); Changed(); }; format.SelectionChanged += (_, _) => Changed();
            model.TextChanged += (_, _) => Changed(); baseUrl.TextChanged += (_, _) => Changed(); cliPath.TextChanged += (_, _) => Changed(); key.PasswordChanged += (_, _) => Changed();
            timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
            timer.Tick += async (_, _) => { if (IsVisible && loginPending && !Busy) await Run(PollLogin); };
            timer.Start(); IsVisibleChanged += (_, _) => { if (!IsVisible) mayOpenAuthorization = false; };
        }
        private void Changed() { if (!applying) { dirty = true; UpdateButtons(); } }
        protected override async Task RefreshAsync() { Apply(await Get("/api/config")); }
        internal void ApplySynthetic(JsonNode node) => Apply(node);
        private void Apply(JsonNode node)
        {
            applying = true;
            try
            {
                mode.SelectedIndex = Text(node, "mode") switch { "codex" => 1, "api" => 2, _ => 0 };
                model.Text = Text(node, "model"); format.SelectedIndex = Text(node, "api.format") == "chat-completions" ? 1 : 0;
                baseUrl.Text = Text(node, "api.baseURL", "https://api.openai.com/v1"); cliPath.Text = Text(node, "codex.cliPath");
                hasKey = Flag(node, "api.hasKey"); configured = Flag(node, "configured"); key.Clear();
                keyNote.Text = hasKey ? "已有 Key；留空只在同一服务 origin 下保留。更换不同服务地址会清空旧 Key，避免发给另一家服务。" : "尚未保存 Key；如刚更换服务，请填写新服务自己的 Key。";
                RenderCodex(At(node, "codex")); dirty = false;
                SetStatus(Text(node, "message", "配置已读取；保存不等于密钥或模型权限已验证。"));
            }
            finally { applying = false; UpdateButtons(); }
        }
        private async Task Save()
        {
            var modes = new[] { "none", "codex", "api" }; var selected = modes[Math.Max(0, mode.SelectedIndex)];
            var body = new JsonObject { ["mode"] = selected, ["model"] = model.Text.Trim() };
            if (selected == "api")
            {
                if (model.Text.Trim().Length == 0) throw new ViewInputException("API 模式需要填写服务商支持的模型名称。");
                if (!Uri.TryCreate(baseUrl.Text.Trim(), UriKind.Absolute, out var url) || !new[] { "https", "http" }.Contains(url.Scheme) || url.UserInfo.Length != 0 || url.Query.Length != 0 || url.Fragment.Length != 0)
                    throw new ViewInputException("Base URL 应为完整的服务根地址，不能包含账号、Key、查询参数或片段。");
                if (url.Scheme == "http" && !new[] { "localhost", "127.0.0.1", "[::1]", "::1" }.Contains(url.Host, StringComparer.OrdinalIgnoreCase))
                    throw new ViewInputException("远程 API 服务必须使用 HTTPS；HTTP 只允许本机 localhost 或回环地址。");
                var api = new JsonObject { ["baseURL"] = baseUrl.Text.Trim(), ["format"] = format.SelectedIndex == 1 ? "chat-completions" : "responses" };
                if (key.Password.Length > 0) api["apiKey"] = key.Password;
                body["api"] = api;
            }
            if (selected == "codex") body["codex"] = new JsonObject { ["cliPath"] = cliPath.Text.Trim() };
            Apply(await Post("/api/config", body));
            SetStatus(configured ? "连接设置已保存，尚未自动测试或调用模型。" : "设置已保存；当前仍可离线使用。请补齐账号、Key 或模型后再测试。");
        }
        private async Task BeginLogin()
        {
            mayOpenAuthorization = true; openedUrl = null;
            Apply(await Post("/api/config", new { mode = "codex", codex = new { cliPath = cliPath.Text.Trim() } }));
            var response = await Post("/api/codex/login", new { });
            loginPending = true; loginId = TextOrNull(response, "loginId"); OpenAuthorization(response);
            SetStatus("请在官方页面完成自己的账号授权，再回到本窗口等待状态刷新。" + (TextOrNull(response, "userCode") is { } code ? " 授权码：" + code : ""));
        }
        private async Task PollLogin()
        {
            var response = await Get("/api/codex/status"); RenderCodex(response); OpenAuthorization(response);
            if (Flag(response, "authenticated")) { loginPending = false; await RefreshAsync(); }
        }
        private void RenderCodex(JsonNode? response)
        {
            if (response == null) return;
            loginPending = Flag(response, "loginPending");
            loginId = TextOrNull(response, "loginId") ?? loginId;
            codexNote.Text = Flag(response, "authenticated")
                ? Flag(response, "restrictedModeVerified") ? "已授权 · 隔离只读受限模式（实验）。仅文字；不保证绝对无工具，发现未知工具会中断。" : "账号已授权，但当前 CLI 兼容检查未通过，AI 生成暂不开放。"
                : Text(response, "message", loginPending ? "等待官方页面完成授权…" : "可以点击官方登录；不会读取其他 Codex 的账号目录。");
            UpdateButtons();
        }
        private void OpenAuthorization(JsonNode response)
        {
            if (!mayOpenAuthorization) return;
            var value = Text(response, "url", Text(response, "authUrl"));
            if (value.Length == 0 || value == openedUrl) return;
            if (!TryOfficialAuthorizationUri(value, out var uri)) throw new ViewInputException("登录地址不是允许的官方 HTTPS 页面，已拒绝打开。");
            Process.Start(new ProcessStartInfo(uri!.AbsoluteUri) { UseShellExecute = true }); openedUrl = value;
        }
        public override void ClosePermanently() { timer.Stop(); base.ClosePermanently(); }
    }

    private sealed class MemoryView : ViewWindow
    {
        private readonly ListBox list;
        private readonly TextBox detail;
        public MemoryView(WindowsViews host) : base(host, "大肥鱼 · 长期记忆")
        {
            Note("这里只管理明确保存在本机的资料。可以在聊天里发送“记住：我喜欢简洁的回答”。查看和删除不调用模型；后续 AI 对话会附上截取后的记忆，并非逐条按话题筛选。");
            list = List(230, true); detail = Output(170);
            list.SelectionChanged += (_, _) => detail.Text = list.SelectedItem is Row row ? string.Join("\n", Items(row.Value, "observations").Select(value => value.ToString())) : "";
            Action("刷新本机记忆", RefreshAsync);
            Action("忘掉选中条目", async () =>
            {
                var names = list.SelectedItems.Cast<Row>().Select(row => row.Id).ToArray();
                if (names.Length == 0) throw new ViewInputException("请先选择要忘掉的记忆条目。");
                await Post("/api/memory/forget", new { names }); await RefreshAsync(); SetStatus("选中的本地记忆已删除；不会撤回之前已发送给模型服务的内容。");
            });
        }
        protected override async Task RefreshAsync()
        {
            var response = await Get("/api/memory/list");
            list.ItemsSource = Items(response, "entities").Select(entity => new Row(Text(entity, "name"), Text(entity, "name") + $" · {Items(entity, "observations").Count()} 条", entity)).ToList();
            detail.Clear(); SetStatus("已读取本机记忆，没有调用模型。");
        }
    }

    private sealed class ReminderView : ViewWindow
    {
        private readonly TextBox reminderText;
        private readonly ComboBox whenMode;
        private readonly TextBox when;
        private readonly TextBox morning;
        private readonly ListBox reminderList;
        private readonly TextBox todoText;
        private readonly ListBox todoList;
        public ReminderView(WindowsViews host) : base(host, "大肥鱼 · 本地提醒与待办", 680, 850)
        {
            Note("本地定时器触发，不额外调用模型。应用必须运行；睡眠或关机期间不保证准时。自然语言“明早”与默认早晨时间按北京时间；下方指定日期使用本机时区。");
            Heading("提醒"); reminderText = Input("提醒内容（单行，1—300 字）");
            whenMode = Choice("时间方式", "若干分钟后", "指定本机时间 yyyy-MM-dd HH:mm"); when = Input("分钟数 / 指定日期时间", "30");
            Action("创建本地提醒", async () =>
            {
                var text = Required(reminderText, "提醒内容"); DateTimeOffset due;
                if (whenMode.SelectedIndex == 0) due = DateTimeOffset.UtcNow.AddMinutes(Integer(when, 1, 525600, "提醒分钟数"));
                else
                {
                    if (!DateTime.TryParseExact(when.Text.Trim(), "yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date) || TimeZoneInfo.Local.IsInvalidTime(date))
                        throw new ViewInputException("指定时间应为有效的 yyyy-MM-dd HH:mm，本机夏令时跳过的时间不能使用。");
                    due = new DateTimeOffset(DateTime.SpecifyKind(date, DateTimeKind.Local));
                }
                if (due <= DateTimeOffset.UtcNow || due > DateTimeOffset.UtcNow.AddDays(365)) throw new ViewInputException("提醒时间必须在未来一年内。");
                await Post("/api/reminders/create", new { text, dueAt = due.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture) });
                reminderText.Clear(); await RefreshAsync(); SetStatus("本地提醒已保存，不会为触发提醒再调用模型。");
            });
            reminderList = List(165);
            Action("完成选中提醒", () => ReminderAction("complete"));
            Action("延后选中提醒 10 分钟", () => ReminderAction("snooze"));
            Action("删除选中提醒（标记取消）", () => ReminderAction("cancel"));
            morning = Input("“明早”的默认北京时间 HH:mm", "09:00");
            Action("保存默认早晨时间", async () => { await Post("/api/reminders/configure", new { defaultMorningTime = Clock(morning) }); SetStatus("默认早晨时间已保存。"); });
            Heading("待办"); todoText = Input("待办内容（单行，1—300 字）");
            Action("添加待办", async () => { await Post("/api/todos/create", new { text = Required(todoText, "待办内容") }); todoText.Clear(); await RefreshAsync(); });
            todoList = List(160);
            Action("完成选中待办", () => TodoAction("complete"));
            Action("重新打开选中待办", () => TodoAction("reopen"));
            Action("删除选中待办（标记取消）", () => TodoAction("cancel"));
            Action("刷新本地记录", RefreshAsync);
            Note("删除操作按后端能力标记为取消，并保留本地历史；不会伪装成物理清除。已取消事项不再显示在此列表。");
        }
        private async Task ReminderAction(string action)
        {
            if (reminderList.SelectedItem is not Row row) throw new ViewInputException("请先选择一条提醒。");
            await Post("/api/reminders/action", new { id = row.Id, action, minutes = 10 }); await RefreshAsync();
        }
        private async Task TodoAction(string action)
        {
            if (todoList.SelectedItem is not Row row) throw new ViewInputException("请先选择一条待办。");
            await Post("/api/todos/action", new { id = row.Id, action }); await RefreshAsync();
        }
        protected override async Task RefreshAsync()
        {
            var response = await Get("/api/reminders"); morning.Text = Text(response, "settings.defaultMorningTime", "09:00");
            reminderList.ItemsSource = Items(response, "reminders").Where(item => Text(item, "status") != "cancelled").Select(item => new Row(Text(item, "id"), StatusName(Text(item, "status")) + " · " + LocalTime(Text(item, "dueAt")) + " · " + Text(item, "text"), item)).ToList();
            todoList.ItemsSource = Items(response, "todos").Where(item => Text(item, "status") != "cancelled").Select(item => new Row(Text(item, "id"), StatusName(Text(item, "status")) + " · " + Text(item, "text"), item)).ToList();
            SetStatus("已读取本地提醒与待办，没有调用模型。");
        }
    }

    private sealed class UsageView : ViewWindow
    {
        private readonly TextBox output;
        private readonly TextBox limit;
        public UsageView(WindowsViews host) : base(host, "大肥鱼 · 用量与预算")
        {
            Note("这里是桌宠记录的提供方报告，不是账号剩余额度或服务商账单。日阈值只暂停后续主动 AI；显式聊天、测试连接和手动网页任务仍可调用。单次响应可能超过阈值。");
            output = Output(280); limit = Input("主动 AI 的每日 token 阈值（0 表示不设置本地日上限）", "0");
            Action("保存预算（不调用模型）", async () => { await Post("/api/usage-policy", new { dailyTokenLimit = Integer(limit, 0, 1_000_000_000_000, "每日 token 阈值") }); await RefreshAsync(); SetStatus("本地预算已保存。"); });
            Action("刷新本地统计", RefreshAsync);
        }
        protected override async Task RefreshAsync()
        {
            var value = await Get("/api/usage"); limit.Text = Number(value, "policy.dailyTokenLimit").ToString(CultureInfo.InvariantCulture);
            output.Text = $"日期：{Text(value, "day")}（{Text(value, "timezone", "Asia/Shanghai")}）\n" +
                $"已报告 tokens：{Number(value, "today.usage.totalTokens")}\n模型调用/回合记录：{Number(value, "today.modelCalls")}\n不完整用量记录：{Number(value, "today.unknownUsageAttempts")}\n\n" +
                $"聊天：{Number(value, "today.byKind.chat.usage.totalTokens")} tokens\n主动消息：{Number(value, "today.byKind.proactive.usage.totalTokens")} tokens\n手动任务：{Number(value, "today.byKind.task.usage.totalTokens")} tokens\n\n" +
                (Flag(value, "gate.blocked") ? "主动 AI 已暂停：" + Text(value, "gate.reason") : "主动 AI 未被本地 token 阈值阻止。") + "\nWindows 首版不支持截图，未启用截图上传。";
            SetStatus("统计依赖提供方返回的用量；未返回时可能暂停后续主动生成。");
        }
    }

    private sealed class CompanionView : ViewWindow
    {
        private readonly TextBox name, quietStart, quietEnd, unanswered, multiplier, backoffMinutes, recentMinutes, focusMinutes, minMinutes, maxMinutes, daily;
        private readonly ComboBox tone, proactiveMode;
        private readonly CheckBox quiet, backoff, recent, enabled;
        public CompanionView(WindowsViews host) : base(host, "大肥鱼 · 陪伴与主动消息", 680, 860)
        {
            Note("保存设置和开关不调用模型。主动 AI 开启后会按本机规则发起后续请求；频率、勿扰和预算共同生效。部分日期和勿扰时间按北京时间计算。");
            Heading("统一称呼与近期话题"); name = Input("称呼（1—20 字）", "你"); tone = Choice("语气", "自然", "温柔", "活泼");
            recent = Toggle("衔接近期生活话题", true); recentMinutes = Input("近期话题最长有效分钟数（1—120）", "120");
            Heading("勿扰与互动退让"); quiet = Toggle("启用北京时间勿扰时段", true); quietStart = Input("开始 HH:mm", "23:00"); quietEnd = Input("结束 HH:mm", "08:00");
            backoff = Toggle("连续未回复时降低互动频率", true); unanswered = Input("连续未回复次数（1—10）", "3"); multiplier = Input("最大退让倍数（1—8）", "8"); backoffMinutes = Input("退让后最长间隔分钟数（1—60）", "60");
            Action("保存陪伴设置（不调用模型）", async () =>
            {
                var preferredName = name.Text.Trim(); if (preferredName.Length is < 1 or > 20) throw new ViewInputException("称呼需要 1—20 字。");
                var start = Clock(quietStart); var end = Clock(quietEnd); if (start == end) throw new ViewInputException("勿扰开始与结束时间不能相同。");
                await Post("/api/companion-settings", new
                {
                    preferences = new { preferredName, tone = new[] { "natural", "gentle", "lively" }[Math.Max(0, tone.SelectedIndex)] },
                    quiet = new { enabled = quiet.IsChecked == true, start, end },
                    backoff = new { enabled = backoff.IsChecked == true, afterUnanswered = Integer(unanswered, 1, 10, "未回复次数"), maxMultiplier = Integer(multiplier, 1, 8, "退让倍数"), maxIntervalSeconds = Integer(backoffMinutes, 1, 60, "退让分钟数") * 60 },
                    recentTopics = new { enabled = recent.IsChecked == true, maxAgeMinutes = Integer(recentMinutes, 1, 120, "话题有效分钟数") }
                });
                SetStatus("称呼、语气、勿扰和退让设置已保存，没有调用模型。");
            });
            focusMinutes = Input("临时专注分钟数（1—1440）", "30");
            Action("开始临时专注", async () => { await Post("/api/companion/focus", new { minutes = Integer(focusMinutes, 1, 1440, "专注分钟数") }); SetStatus("已开始临时专注，期间暂停主动互动。"); });
            Action("结束临时专注", async () => { await Post("/api/companion/focus", new { minutes = 0 }); SetStatus("临时专注已结束；其他勿扰规则仍有效。"); });
            Action("清空近期话题（保留聊天与长期记忆）", async () => { await Post("/api/companion/clear-recent", new { }); SetStatus("近期话题已清空，聊天记录与长期记忆保留。"); });
            Heading("主动消息"); enabled = Toggle("启用主动互动（AI 模式会消耗额度）"); proactiveMode = Choice("生成方式", "经济模式（本地短句与少量 AI）", "AI 模式（每次由模型生成）");
            minMinutes = Input("随机最短间隔，分钟（1—1440）", "1"); maxMinutes = Input("随机最长间隔，分钟（1—1440）", "10"); daily = Input("每日最多主动 AI 次数（0 表示不限制）", "24");
            Action("保存主动互动设置（此时不调用模型）", async () =>
            {
                var minimum = Integer(minMinutes, 1, 1440, "最短间隔"); var maximum = Integer(maxMinutes, minimum, 1440, "最长间隔");
                await Post("/api/proactive-policy", new { enabled = enabled.IsChecked == true, mode = proactiveMode.SelectedIndex == 1 ? "ai" : "economy", minIntervalSeconds = minimum * 60, maxIntervalSeconds = maximum * 60, dailyAiLimit = Integer(daily, 0, 10000, "每日 AI 次数") });
                SetStatus("主动互动规则已保存。启用后后续 AI 生成会按规则消耗额度。");
            });
            Action("现在试着说一句（AI 可能消耗额度）", async () => { await Post("/api/proactive/preview", new { uiBusy = false, typing = false }); SetStatus("已请求一次主动互动预览；实际投递仍由本机规则控制。"); });
            Action("刷新本地设置", RefreshAsync);
        }
        protected override async Task RefreshAsync()
        {
            var snapshot = await Get("/api/companion-settings"); var settings = At(snapshot, "settings");
            name.Text = Text(settings, "preferences.preferredName", "你"); tone.SelectedIndex = Text(settings, "preferences.tone") switch { "gentle" => 1, "lively" => 2, _ => 0 };
            quiet.IsChecked = Flag(settings, "quiet.enabled", true); quietStart.Text = Text(settings, "quiet.start", "23:00"); quietEnd.Text = Text(settings, "quiet.end", "08:00");
            backoff.IsChecked = Flag(settings, "backoff.enabled", true); unanswered.Text = Number(settings, "backoff.afterUnanswered", 3).ToString(); multiplier.Text = Number(settings, "backoff.maxMultiplier", 8).ToString(); backoffMinutes.Text = Math.Max(1, Number(settings, "backoff.maxIntervalSeconds", 3600) / 60).ToString();
            recent.IsChecked = Flag(settings, "recentTopics.enabled", true); recentMinutes.Text = Number(settings, "recentTopics.maxAgeMinutes", 120).ToString();
            var proactive = await Get("/api/proactive-policy"); var policy = At(proactive, "policy");
            enabled.IsChecked = Flag(policy, "enabled"); proactiveMode.SelectedIndex = Text(policy, "mode") == "ai" ? 1 : 0;
            minMinutes.Text = Math.Max(1, Number(policy, "minIntervalSeconds", 60) / 60).ToString(); maxMinutes.Text = Math.Max(1, Number(policy, "maxIntervalSeconds", 600) / 60).ToString(); daily.Text = Number(policy, "dailyAiLimit", 24).ToString();
            SetStatus("已读取本地设置，没有调用模型。当前临时专注截止：" + (TextOrNull(settings, "focusUntil") is { } until ? LocalTime(until) : "未启用"));
        }
    }

    private sealed class TaskView : ViewWindow
    {
        private readonly TextBox goal, urls, detail;
        private readonly ListBox list;
        private readonly DispatcherTimer timer;
        private string? selectedId;
        public TaskView(WindowsViews host) : base(host, "大肥鱼 · 只读公开网页任务", 800, 820)
        {
            Note("只读取公开网页，不登录、不发帖、不控制浏览器或文件。没有具体网址时，会把目标用于 Bing 搜索。网页结果整理会使用模型额度；最长约 3 分钟，读取受次数和输入上限限制。");
            goal = Input("任务目标（1—4000 字）", multiline: true); urls = Input("优先读取的公开网址（可留空，每行一个，最多 6 个）", multiline: true);
            Action("手动启动任务（会使用 AI）", async () =>
            {
                var text = goal.Text.Trim(); if (text.Length is < 1 or > 4000) throw new ViewInputException("任务目标需要 1—4000 字。");
                var targets = urls.Text.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Distinct().ToArray();
                if (targets.Length > 6 || targets.Any(value => !Uri.TryCreate(value, UriKind.Absolute, out var uri) || !new[] { "http", "https" }.Contains(uri.Scheme) || uri.UserInfo.Length != 0)) throw new ViewInputException("最多填写 6 个公开 HTTP/HTTPS 网址，不能包含账号密码。");
                var response = await Post("/api/tasks/start", new { goal = text, urls = targets }); var task = At(response, "task"); selectedId = TextOrNull(task, "id"); RenderTask(task); await RefreshList(); SetStatus("任务已启动。可随时停止；未读到的页面不能当作已完成。");
            });
            list = List(140); detail = Output(290);
            list.SelectionChanged += async (_, _) => { if (list.SelectedItem is Row row) { selectedId = row.Id; if (!Busy) await Run(PollTask); } };
            Action("刷新任务列表 / 状态（不调用模型）", RefreshAsync);
            Action("停止选中任务", async () => { if (selectedId == null) throw new ViewInputException("请先选择一项任务。"); var response = await Post("/api/tasks/stop", new { id = selectedId }); RenderTask(At(response, "task")); SetStatus("已请求停止；以任务实际状态为准。"); });
            timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) }; timer.Tick += async (_, _) => { if (IsVisible && selectedId != null && !Busy) await Run(PollTask); }; timer.Start();
        }
        private async Task RefreshList()
        {
            var response = await Get("/api/tasks/list"); list.ItemsSource = Items(response, "tasks").Select(item => new Row(Text(item, "id"), StatusName(Text(item, "status")) + " · " + Text(item, "goal"), item)).ToList();
        }
        private async Task PollTask()
        {
            if (selectedId == null) return;
            var response = await Get("/api/tasks/status?id=" + Uri.EscapeDataString(selectedId)); RenderTask(At(response, "task"));
        }
        private void RenderTask(JsonNode? task)
        {
            if (task == null) return;
            var sources = Items(task, "sources").Select(item => (Text(item, "kind") == "search" ? "搜索结果页：" : "已读取：") + Text(item, "url"));
            var events = Items(task, "events").Select(item => LocalTime(Text(item, "at")) + " · " + Text(item, "message", Text(item, "type")));
            detail.Text = $"状态：{StatusName(Text(task, "status"))}\n目标：{Text(task, "goal")}\n模型回合：{Number(task, "modelCalls")} · 网页工具：{Number(task, "toolCalls")}\n\n" + Text(task, "result") + "\n\n" + Text(task, "error.message") + "\n\n实际来源\n" + string.Join("\n", sources) + "\n\n过程\n" + string.Join("\n", events);
            detail.ScrollToEnd();
        }
        protected override async Task RefreshAsync() { await RefreshList(); await PollTask(); SetStatus("已读取本地任务状态，没有额外调用模型。"); }
        public override void ClosePermanently() { timer.Stop(); base.ClosePermanently(); }
    }

    private static string Required(TextBox input, string label)
    {
        var value = input.Text.Trim();
        if (value.Length is < 1 or > 300 || value.Any(char.IsControl)) throw new ViewInputException(label + "需要 1—300 字的单行内容。");
        return value;
    }
    private static string Clock(TextBox input)
    {
        var value = input.Text.Trim();
        if (!Regex.IsMatch(value, "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$")) throw new ViewInputException("时间应使用 24 小时制 HH:mm。");
        return value;
    }
    private static string LocalTime(string value)
        => DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var date) ? date.ToLocalTime().ToString("MM-dd HH:mm", CultureInfo.CurrentCulture) : value;
    private static string StatusName(string value) => value switch
    {
        "pending" => "待处理", "due" => "已到时间", "queued" => "排队中", "running" => "运行中", "stopping" => "正在停止",
        "completed" => "已完成", "cancelled" => "已取消", "stopped" => "已停止", "failed" => "未完成", "budget_exhausted" => "达到上限", "interrupted" => "已中断", _ => value
    };
}
