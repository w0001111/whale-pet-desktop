using System;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;

namespace WhalePet.Windows;

public sealed class BubbleWindow : Window
{
    private readonly TextBlock _message = new() { TextWrapping = TextWrapping.Wrap, FontSize = 14, Foreground = Brushes.Black };
    private readonly ScrollViewer _messageScroll = new() { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, MaxHeight = 260 };
    private readonly TextBlock _source = new() { FontSize = 11, Foreground = Brushes.SlateGray };
    private readonly TextBlock _status = new() { TextWrapping = TextWrapping.Wrap, FontSize = 11, Foreground = Brushes.Firebrick };
    private readonly TextBox _input = new() { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 54, MaxHeight = 150, MaxLength = 6000, FontSize = 13, Padding = new Thickness(6) };
    private readonly StackPanel _editor = new() { Visibility = Visibility.Collapsed };
    private readonly StackPanel _reminderButtons = new() { Orientation = Orientation.Horizontal, Visibility = Visibility.Collapsed };
    private readonly Button _send = Button("发送"), _pin = Button("暂留");
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(40) };
    private readonly PetWindow _owner;
    private bool _pinned, _closing;
    private string? _reminderId;
    public bool IsEditing => IsVisible && _editor.Visibility == Visibility.Visible;
    public bool HasDraft => !string.IsNullOrWhiteSpace(_input.Text);
    public string DisplayedText => _message.Text;

    public BubbleWindow(PetWindow owner)
    {
        _owner = owner;
        Width = 350; SizeToContent = SizeToContent.Height; MinHeight = 90; MaxHeight = 560;
        WindowStyle = WindowStyle.None; AllowsTransparency = true; Background = Brushes.Transparent;
        Topmost = true; ShowInTaskbar = false; ShowActivated = false; ResizeMode = ResizeMode.NoResize;
        Title = "Whale Pet · 回复气泡";
        var root = new StackPanel { Margin = new Thickness(14) };
        _messageScroll.Content = _message;
        root.Children.Add(_source); root.Children.Add(_messageScroll);
        var row = new WrapPanel { Margin = new Thickness(0, 9, 0, 0) };
        var reply = Button("直接回复"); reply.Click += (_, _) => BeginReply();
        var chat = Button("打开聊天"); chat.Click += (_, _) => _owner.OpenChat();
        _pin.Click += (_, _) => { _pinned = !_pinned; _pin.Content = _pinned ? "取消暂留" : "暂留"; RestartTimer(); };
        var later = Button("稍后聊"); later.Click += async (_, _) => await LaterAsync();
        var hide = Button("收起"); hide.Click += (_, _) => Dismiss();
        foreach (Button item in new[] { reply, chat, _pin, later, hide }) row.Children.Add(item);
        root.Children.Add(row);
        var done = Button("提醒已完成"); done.Click += async (_, _) => await ReminderAsync("complete", 0);
        var snooze = Button("10 分钟后再提醒"); snooze.Click += async (_, _) => await ReminderAsync("snooze", 10);
        _reminderButtons.Children.Add(done); _reminderButtons.Children.Add(snooze); root.Children.Add(_reminderButtons);
        _editor.Children.Add(_input); _editor.Children.Add(_send); root.Children.Add(_editor); root.Children.Add(_status);
        _send.Click += async (_, _) => await SendAsync();
        _input.PreviewKeyDown += async (_, value) => { if (value.Key == Key.Enter && !Keyboard.Modifiers.HasFlag(ModifierKeys.Shift)) { value.Handled = true; await SendAsync(); } };
        _input.TextChanged += (_, _) => { _owner.RefreshPresenceSoon(); RestartTimer(); };
        Content = new Border { Background = new SolidColorBrush(Color.FromRgb(249, 252, 255)), BorderBrush = Brushes.LightSteelBlue,
            BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(15), Child = root };
        SourceInitialized += (_, _) => NativeMethods.ToolWindow(this, !IsEditing);
        SizeChanged += (_, _) => PositionNearPet();
        MouseEnter += (_, _) => _timer.Stop(); MouseLeave += (_, _) => RestartTimer();
        _timer.Tick += (_, _) => { _timer.Stop(); if (!_pinned && !IsEditing && !HasDraft && !_owner.ConversationBusy) Hide(); };
        Closing += (_, value) => { if (!_closing) { value.Cancel = true; Dismiss(); } };
    }
    private static Button Button(string text) => new() { Content = text, Margin = new Thickness(0, 2, 5, 2), Padding = new Thickness(7, 4, 7, 4), MinHeight = 27 };
    public void SetMessage(string text, string source, bool proactive, string? kind = null, string? reminderId = null)
    {
        _message.Text = text.Length > 16000 ? text[..16000] + "\n…（完整回复见聊天窗口）" : text;
        _messageScroll.ScrollToTop();
        _source.Text = kind != null ? "大肥鱼 · 本地通知" : source == "local" ? "大肥鱼 · 本地互动" : proactive ? "大肥鱼 · 主动陪伴" : "大肥鱼 · AI 回复";
        _status.Text = ""; _reminderId = reminderId;
        _reminderButtons.Visibility = reminderId == null ? Visibility.Collapsed : Visibility.Visible;
        PositionNearPet();
    }
    public void ShowMessage(string text, string source, bool proactive, string? kind = null, string? reminderId = null)
    { SetMessage(text, source, proactive, kind, reminderId); ShowActivated = false; NativeMethods.ToolWindow(this, !IsEditing); Show(); PositionNearPet(); RestartTimer(); }
    public void PositionNearPet()
    {
        Rect area = NativeMethods.WorkArea(_owner);
        double height = ActualHeight > 10 ? ActualHeight : 210;
        double right = _owner.Left + _owner.Width + 8, left = _owner.Left - Width - 8;
        Left = Math.Clamp(right + Width <= area.Right ? right : left, area.Left, Math.Max(area.Left, area.Right - Width));
        Top = Math.Clamp(_owner.Top - height * .25, area.Top, Math.Max(area.Top, area.Bottom - height));
    }
    public void BeginReply()
    {
        if (!IsVisible) Show();
        _editor.Visibility = Visibility.Visible; _messageScroll.MaxHeight = 180; _timer.Stop(); NativeMethods.ToolWindow(this, false);
        Activate(); _input.Focus(); Keyboard.Focus(_input); _owner.RefreshPresenceSoon();
    }
    public void CompleteReply()
    { _input.Clear(); _editor.Visibility = Visibility.Collapsed; _messageScroll.MaxHeight = 260; NativeMethods.ToolWindow(this, true); _status.Text = ""; RestartTimer(); }
    public void SetBusy(bool busy) { _send.IsEnabled = !busy; _input.IsEnabled = !busy; _send.Content = busy ? "回复中…" : "发送"; }
    private async Task SendAsync()
    {
        string text = _input.Text.Trim();
        if (text.Length == 0 || _owner.ConversationBusy) return;
        try { await _owner.SendInlineReplyAsync(text); }
        catch (Exception error) { _status.Text = error.Message; _input.IsEnabled = true; _send.IsEnabled = true; }
    }
    private async Task LaterAsync()
    {
        try { await _owner.SnoozeConversationAsync(10); Dismiss(); }
        catch (Exception error) { _status.Text = "稍后聊设置未完成：" + error.Message; }
    }
    private async Task ReminderAsync(string action, int minutes)
    {
        if (_reminderId == null) return;
        try { await _owner.ReminderActionAsync(_reminderId, action, minutes); _reminderButtons.Visibility = Visibility.Collapsed; _status.Text = action == "complete" ? "提醒已完成。" : "已设置稍后提醒。"; }
        catch (Exception error) { _status.Text = "提醒操作未完成：" + error.Message; }
    }
    private void RestartTimer() { _timer.Stop(); if (!_pinned && !IsEditing && !HasDraft) _timer.Start(); }
    private void Dismiss() { _editor.Visibility = Visibility.Collapsed; _messageScroll.MaxHeight = 260; NativeMethods.ToolWindow(this, true); Hide(); _owner.RefreshPresenceSoon(); }
    internal void PrepareSyntheticReply() { _editor.Visibility = Visibility.Visible; _messageScroll.MaxHeight = 180; _input.Text = "合成回复草稿，不会发送"; }
    public void Shutdown() { _closing = true; _timer.Stop(); Close(); }
}
