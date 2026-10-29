using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using Forms = System.Windows.Forms;
using Drawing = System.Drawing;

namespace WhalePet.Windows;

public sealed class PetWindow : Window
{
    private sealed record Notice(string Text, string Source, bool Proactive, string? Kind, string? ReminderId, string? Id);
    private readonly ServiceClient _service;
    private readonly WindowsViews _views;
    private readonly PetSettings _settings;
    private readonly bool _settingsWritable, _selfTest;
    private readonly PetAnimator _animator;
    private readonly PetWalker _walker = new();
    private readonly Image _image = new() { Stretch = Stretch.Uniform, Margin = new Thickness(7, 9, 7, 10), RenderTransformOrigin = new Point(.5, .5) };
    private readonly TextBlock _emotion = new() { FontSize = 23, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Top, IsHitTestVisible = false };
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromMilliseconds(66) };
    private readonly DispatcherTimer _inboxTimer = new() { Interval = TimeSpan.FromSeconds(5) };
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly BubbleWindow _bubble;
    private readonly Queue<Notice> _pending = new();
    private readonly HashSet<string> _shown = new(StringComparer.Ordinal);
    private readonly HashSet<string> _queued = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource _stop = new();
    private Forms.NotifyIcon? _tray;
    private Drawing.Icon? _trayIcon;
    private Point? _dragStart;
    private Point _windowStart;
    private bool _dragging, _facingLeft, _polling, _busy, _closing;
    private int _pollCount;
    private double _lastTick, _nextAction = 20;
    private double _nextNoticeAt;
    private Notice? _latest;
    private DateTimeOffset _snoozeUntil;
    public bool ConversationHasDraft { get; set; }
    public bool ConversationBusy
    {
        get => _busy;
        set { _busy = value; _bubble?.SetBusy(value); SetEmotion(value ? "thinking" : "idle"); }
    }
    public WindowsViews Views => _views;
    public bool IsClosing => _closing;
    public PetAnimator Animator => _animator;
    public BubbleWindow Bubble => _bubble;

    public PetWindow(ServiceClient service, bool selfTest = false)
    {
        _service = service; _selfTest = selfTest;
        _settings = PetSettings.Load(service.DataRoot, out string? settingsError); _settingsWritable = settingsError == null;
        _animator = new PetAnimator(Path.Combine(service.ResourceRoot, "assets"));
        _bubble = new BubbleWindow(this); _views = new WindowsViews(service, this);
        Title = "Whale Pet · 大肥鱼桌宠"; WindowStyle = WindowStyle.None; AllowsTransparency = true; Background = Brushes.Transparent;
        ShowInTaskbar = false; ShowActivated = false; Topmost = true; ResizeMode = ResizeMode.NoResize;
        Width = _settings.Height + 20; Height = _settings.Height + 24;
        var root = new Grid { Background = Brushes.Transparent };
        root.Children.Add(_image); root.Children.Add(_emotion); Content = root;
        _image.Source = _animator.CurrentFrame;
        ToolTip = "点我聊天，拖动移动，右键打开菜单";
        SourceInitialized += (_, _) =>
        {
            NativeMethods.ToolWindow(this, true);
            HwndSource.FromHwnd(new WindowInteropHelper(this).Handle)?.AddHook(WindowHook);
        };
        Loaded += (_, _) =>
        {
            Rect area = NativeMethods.WorkArea(this);
            Point position = _settings.Left is double x && _settings.Top is double y ? new Point(x, y) : new Point(area.Right - Width - 25, area.Bottom - Height - 25);
            MoveTo(PetWalker.Clamp(position, area, new Size(Width, Height)));
            if (!_selfTest) { CreateTray(); _timer.Start(); _inboxTimer.Start(); }
        };
        MouseLeftButtonDown += (_, value) => { _dragStart = NativeMethods.CursorPosition(); _windowStart = new Point(Left, Top); _dragging = false; CaptureMouse(); value.Handled = true; };
        MouseMove += (_, _) =>
        {
            if (_dragStart == null || Mouse.LeftButton != MouseButtonState.Pressed) return;
            Vector delta = NativeMethods.CursorPosition() - _dragStart.Value;
            DpiScale dpi = VisualTreeHelper.GetDpi(this); delta = new Vector(delta.X / dpi.DpiScaleX, delta.Y / dpi.DpiScaleY);
            if (delta.Length > 4) _dragging = true;
            if (_dragging) { MoveTo(PetWalker.Clamp(_windowStart + delta, NativeMethods.WorkArea(this), new Size(Width, Height))); _walker.Reset(); }
        };
        MouseLeftButtonUp += (_, value) =>
        {
            if (_dragStart == null) return;
            ReleaseMouseCapture(); _dragStart = null; SavePosition();
            if (!_dragging) OpenChat(); _dragging = false; value.Handled = true;
        };
        MouseRightButtonUp += (_, value) => { BuildMenu().IsOpen = true; value.Handled = true; };
        _timer.Tick += (_, _) => Tick(); _inboxTimer.Tick += async (_, _) => await PollAsync();
        Closing += (_, value) => { if (!_closing) { value.Cancel = true; _ = ExitAsync(); } };
    }
    private IntPtr WindowHook(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (message == NativeMethods.WM_MOUSEACTIVATE) { handled = true; return new IntPtr(NativeMethods.MA_NOACTIVATE); }
        if (message == NativeMethods.WM_NCHITTEST && !_dragging)
        {
            Point point = _image.PointFromScreen(NativeMethods.CursorPosition());
            if (!_animator.OpaqueAt(point, new Size(_image.ActualWidth, _image.ActualHeight))) { handled = true; return new IntPtr(NativeMethods.HTTRANSPARENT); }
        }
        return IntPtr.Zero;
    }
    private void Tick()
    {
        double now = _clock.Elapsed.TotalSeconds, elapsed = Math.Min(.1, Math.Max(0, now - _lastTick)); _lastTick = now;
        bool reduced = !SystemParameters.ClientAreaAnimation;
        bool mayMove = _settings.Wandering && !_dragging && !IsMouseOver && !ConversationBusy && !ConversationHasDraft && !_bubble.IsEditing && !_views.HasVisibleWindows && !reduced && !_animator.IsExclusive(now);
        Rect area = NativeMethods.WorkArea(this); var size = new Size(Width, Height);
        if (mayMove) _walker.Prepare(new Point(Left, Top), area, size, now);
        _animator.SetWalking(mayMove && _walker.WantsWalking, now);
        if (_animator.Update(now, reduced)) _image.Source = _animator.CurrentFrame;
        Point position = new(Left, Top);
        Point next = _walker.Step(position, area, size, elapsed, mayMove && _animator.IsWalking, now);
        if (Math.Abs(next.X - Left) > .01) _facingLeft = next.X < Left;
        if ((next - position).Length > .01) MoveTo(next);
        double breath = reduced || _animator.CurrentClip != "idle" ? 1 : 1 + Math.Sin(now * 2.1) * .009;
        _image.RenderTransform = new ScaleTransform((_facingLeft ? -1 : 1) * breath, breath);
        Point pointer = _image.PointFromScreen(NativeMethods.CursorPosition());
        NativeMethods.InputTransparent(this, !_dragging && !_animator.OpaqueAt(pointer, new Size(_image.ActualWidth, _image.ActualHeight)));
        if (_settings.AutomaticActions && !ConversationBusy && !_views.HasVisibleWindows && !mayMove && now > _nextAction && !_animator.IsExclusive(now))
        { _nextAction = now + 30 + Random.Shared.NextDouble() * 40; _animator.PlayAction(Random.Shared.Next(3) == 0 ? "eat" : "music", now, 5); }
        FlushNotices();
    }
    private void MoveTo(Point point) { Left = point.X; Top = point.Y; if (_bubble.IsVisible) _bubble.PositionNearPet(); }
    private void SavePosition() { _settings.Left = Left; _settings.Top = Top; if (_settingsWritable) _settings.Save(_service.DataRoot); }
    private void ToggleWalking() { _settings.Wandering = !_settings.Wandering; _walker.Reset(); SavePosition(); }
    private void ResizePet(double height) { _settings.Height = height; Width = height + 20; Height = height + 24; MoveTo(PetWalker.Clamp(new Point(Left, Top), NativeMethods.WorkArea(this), new Size(Width, Height))); SavePosition(); }
    public void OpenChat() { SetEmotion("listening"); _views.ShowChat(); }
    public void SetEmotion(string emotion)
    {
        _animator.Emotion = emotion;
        _emotion.Text = emotion switch { "thinking" => "💭", "listening" => "👂", "happy" => "✨", "sleepy" => "💤", "surprised" => "!", "sad" => "…", _ => "" };
    }
    public void ShowBubble(string text, string source = "local", bool proactive = false, string? kind = null, string? reminderId = null)
    { _pending.Enqueue(new Notice(text, source, proactive, kind, reminderId, null)); FlushNotices(); }
    public void ReceiveChatResponse(JsonNode response)
    {
        string text = response["text"]?.GetValue<string>() ?? "";
        if (string.IsNullOrWhiteSpace(text)) return;
        _bubble.CompleteReply(); SetEmotion("happy");
        _latest = new Notice(text, response["source"]?.GetValue<string>() ?? "api", false, null, null, null);
        _bubble.ShowMessage(_latest.Text, _latest.Source, false);
    }
    public async Task<JsonNode> SendInlineReplyAsync(string text)
    {
        if (ConversationBusy) throw new InvalidOperationException("正在回复上一条消息，请稍后发送。");
        JsonNode response = await _views.SendInlineReplyAsync(text); ReceiveChatResponse(response); return response;
    }
    public Task ReminderActionAsync(string id, string action, int minutes) => _service.RequestAsync("/api/reminders/action", new { id, action, minutes });
    public async Task SnoozeConversationAsync(int minutes)
    { await _service.RequestAsync("/api/companion/focus", new { minutes }); _snoozeUntil = DateTimeOffset.UtcNow.AddMinutes(minutes); }
    public void RefreshPresenceSoon() { if (!_selfTest && !_polling && _service.IsRunning) _ = PollAsync(); }
    private void FlushNotices()
    {
        if (_pending.Count == 0 || ConversationBusy || ConversationHasDraft || (_bubble.IsVisible && (_bubble.IsEditing || _bubble.HasDraft))) return;
        if (_bubble.IsVisible && _clock.Elapsed.TotalSeconds < _nextNoticeAt) return;
        Notice value = _pending.Dequeue(); _latest = value;
        if (value.Id != null) _queued.Remove(value.Id);
        if (value.Proactive && DateTimeOffset.UtcNow < _snoozeUntil) return;
        if (value.Id != null && !_shown.Add(value.Id)) return;
        _nextNoticeAt = _clock.Elapsed.TotalSeconds + 12;
        _bubble.ShowMessage(value.Text, value.Source, value.Proactive, value.Kind, value.ReminderId);
    }
    private async Task PollAsync()
    {
        if (_polling || _closing || !_service.IsRunning) return;
        _polling = true;
        try
        {
            JsonNode local = await _service.RequestAsync("/api/local-events/inbox", cancellationToken: _stop.Token);
            var ids = new List<string>();
            foreach (JsonNode? item in local["events"]?.AsArray() ?? new JsonArray())
            {
                if (ids.Count >= 10 || item == null) break;
                string? id = item["id"]?.GetValue<string>(); if (string.IsNullOrWhiteSpace(id)) continue;
                var message = new JsonObject { ["text"] = item["text"]?.DeepClone(), ["source"] = "local", ["model"] = "local-reminder", ["kind"] = item["kind"]?.DeepClone(), ["reminderId"] = item["reminderId"]?.DeepClone(), ["at"] = item["at"]?.DeepClone() };
                if (!_views.RecordIncoming(message, id)) break;
                if (!_shown.Contains(id) && _queued.Add(id)) _pending.Enqueue(new Notice(message["text"]?.GetValue<string>() ?? "", "local", false, message["kind"]?.GetValue<string>(), message["reminderId"]?.GetValue<string>(), id));
                ids.Add(id);
            }
            if (ids.Count > 0) await _service.RequestAsync("/api/local-events/ack", new { ids }, _stop.Token);
            if (++_pollCount % 3 == 0 || _pollCount == 1)
            {
                bool busy = ConversationBusy || _views.HasVisibleWindows, typing = ConversationHasDraft || (_bubble.IsVisible && (_bubble.IsEditing || _bubble.HasDraft));
                string route = "/api/proactive/inbox?uiBusy=" + (busy ? "1" : "0") + "&typing=" + (typing ? "1" : "0") + (_settings.ProactiveCursor == null ? "" : "&after=" + Uri.EscapeDataString(_settings.ProactiveCursor));
                JsonNode inbox = await _service.RequestAsync(route, cancellationToken: _stop.Token);
                bool persisted = true;
                foreach (JsonNode? item in inbox["messages"]?.AsArray() ?? new JsonArray())
                {
                    if (item == null) continue;
                    string? id = item["id"]?.GetValue<string>();
                    if (!_views.RecordIncoming(item, id)) { persisted = false; break; }
                    if (id == null || (!_shown.Contains(id) && _queued.Add(id))) _pending.Enqueue(new Notice(item["text"]?.GetValue<string>() ?? "", item["source"]?.GetValue<string>() ?? "local", true, null, null, id));
                }
                if (persisted && inbox["cursor"]?.GetValue<string>() is string cursor) { _settings.ProactiveCursor = cursor; if (_settingsWritable) _settings.Save(_service.DataRoot); }
            }
            FlushNotices();
        }
        catch (OperationCanceledException) { }
        catch { /* Retry local state later. No fabricated task completion or acknowledgement. */ }
        finally { _polling = false; }
    }
    private void ReplayBubble() { if (_latest != null) _bubble.ShowMessage(_latest.Text, _latest.Source, _latest.Proactive, _latest.Kind, _latest.ReminderId); else OpenChat(); }
    private IEnumerable<(string? Title, Action? Action)> MenuActions()
    {
        yield return ("打开聊天", OpenChat); yield return ("AI 连接设置", _views.ShowSetup); yield return ("重显上一条气泡", ReplayBubble);
        yield return ("提醒与待办", _views.ShowReminders); yield return ("用量与预算", _views.ShowUsage); yield return ("后台网页任务", _views.ShowTasks);
        yield return ("长期记忆", _views.ShowMemory); yield return ("主动聊天设置", _views.ShowProactiveSettings); yield return (null, null);
        yield return (_settings.Wandering ? "暂停散步" : "开始散步", ToggleWalking);
        yield return ("挥个手", () => { SetEmotion("happy"); _animator.PlayAction("cheer", _clock.Elapsed.TotalSeconds, 4); });
        foreach (var pair in new[] { ("起身", "standUp"), ("吃东西", "eat"), ("欢呼", "cheer"), ("打游戏", "gaming"), ("听音乐", "music"), ("坐下", "sitDown") })
        { var action = pair; yield return (action.Item1, () => _animator.PlayAction(action.Item2, _clock.Elapsed.TotalSeconds)); }
        yield return ("小号宠物", () => ResizePet(140)); yield return ("中号宠物", () => ResizePet(180)); yield return ("大号宠物", () => ResizePet(220));
        yield return ("找回宠物", () => { Rect area = NativeMethods.WorkArea(this); MoveTo(new Point(area.Right - Width - 20, area.Bottom - Height - 20)); SavePosition(); });
        yield return (null, null); yield return ("退出大肥鱼", () => { _ = ExitAsync(); });
    }
    private ContextMenu BuildMenu()
    {
        var menu = new ContextMenu();
        foreach (var item in MenuActions()) { if (item.Title == null) { menu.Items.Add(new Separator()); continue; } var entry = new MenuItem { Header = item.Title }; entry.Click += (_, _) => item.Action?.Invoke(); menu.Items.Add(entry); }
        return menu;
    }
    private void CreateTray()
    {
        _trayIcon = Drawing.Icon.ExtractAssociatedIcon(Environment.ProcessPath ?? "") ?? (Drawing.Icon)Drawing.SystemIcons.Application.Clone();
        _tray = new Forms.NotifyIcon { Icon = _trayIcon, Text = "Whale Pet · 大肥鱼桌宠", Visible = true };
        var menu = new Forms.ContextMenuStrip();
        foreach (var item in MenuActions())
        { if (item.Title == null) { menu.Items.Add(new Forms.ToolStripSeparator()); continue; } var entry = new Forms.ToolStripMenuItem(item.Title); entry.Click += (_, _) => Dispatcher.Invoke(() => item.Action?.Invoke()); menu.Items.Add(entry); }
        _tray.ContextMenuStrip = menu; _tray.DoubleClick += (_, _) => Dispatcher.Invoke(OpenChat);
    }
    public void ShowFirstSetupIfNeeded()
    { if (_settings.OnboardingSeen) return; _views.ShowSetup(); _settings.OnboardingSeen = true; if (_settingsWritable) _settings.Save(_service.DataRoot); }
    public async Task ExitAsync()
    {
        if (_closing) return; _closing = true; _timer.Stop(); _inboxTimer.Stop(); _stop.Cancel();
        SavePosition(); _views.Shutdown(); _bubble.Shutdown(); _tray?.Dispose(); _trayIcon?.Dispose();
        await _service.StopAsync(); Close(); System.Windows.Application.Current?.Shutdown();
    }
    internal void CloseForSelfTest() { _closing = true; _timer.Stop(); _inboxTimer.Stop(); _views.Shutdown(); _bubble.Shutdown(); Close(); }
}
