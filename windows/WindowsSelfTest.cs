using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace WhalePet.Windows;

internal static class WindowsSelfTest
{
    internal static int Run(string? outputDirectory)
    {
        string root = Path.Combine(Path.GetTempPath(), "whale-wpf-synthetic-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        string output = Path.GetFullPath(outputDirectory ?? Path.Combine(root, "snapshots"));
        Directory.CreateDirectory(output);
        var checks = new Dictionary<string, bool>();
        PetWindow? pet = null; ServiceClient? service = null;
        void Check(string name, bool value) { checks[name] = value; if (!value) throw new InvalidOperationException(name); }
        try
        {
            System.Windows.Media.RenderOptions.ProcessRenderMode = System.Windows.Interop.RenderMode.SoftwareOnly;
            service = new ServiceClient(root, Path.Combine(AppContext.BaseDirectory, "service"), syntheticTest: true);
            Check("isolated-new-data-root", service.AppDataRoot == Path.GetFullPath(root) && service.IsSyntheticTestRoot);
            Check("no-service-process", !service.IsRunning);
            Check("loopback-relative-route-only", ServiceClient.SafeRoute("/api/config") && !ServiceClient.SafeRoute("//example.com") && !ServiceClient.SafeRoute("https://example.com") && !ServiceClient.SafeRoute("/\\example.com"));
            var settings = new PetSettings(); Check("privacy-defaults-off", !settings.AppInfoEnabled && !settings.ScreenshotsEnabled);
            Check("settings-own-root-roundtrip", settings.Save(service.DataRoot) && PetSettings.Load(service.DataRoot, out _).Height == settings.Height);
            pet = new PetWindow(service, selfTest: true) { Left = 100, Top = 100 };
            Check("transparent-nonactivating-tool-window", pet.AllowsTransparency && pet.WindowStyle == WindowStyle.None && !pet.ShowActivated && !pet.ShowInTaskbar && pet.Topmost);
            var animator = pet.Animator;
            Check("eight-local-action-clips", animator.ClipCount >= 8 && new[] { "standUp", "stand", "walk", "eat", "sitDown", "cheer", "gaming", "music" }.All(animator.ClipIds.Contains));
            animator.SetWalking(true, 0); animator.Update(.1); Check("rise-before-gait", animator.CurrentClip == "standUp" && !animator.IsWalking);
            animator.Update(1); BitmapSource? first = animator.CurrentFrame; animator.Update(1.3);
            Check("gait-frame-really-advances", animator.IsWalking && !ReferenceEquals(first, animator.CurrentFrame));
            animator.SetWalking(false, 2); animator.Update(2.5); Check("pause-stops-gait", !animator.IsWalking);
            Check("eating-action-available", animator.PlayAction("eat", 3, 2)); animator.Update(3.3); Check("eating-frames-visible", animator.CurrentClip == "eat" && animator.CurrentFrame != null);
            var walker = new PetWalker(42); Rect area = new(0, 0, 800, 600); Size size = new(200, 200); Point position = new(500, 300);
            walker.Prepare(position, area, size, 0); Check("two-dimensional-target", walker.WantsWalking);
            Check("paused-planner-does-not-move", walker.Step(position, area, size, .066, false, .066) == position);
            bool inBounds = true, movedX = false, movedY = false;
            for (int n = 1; n <= 500; n++)
            { Point next = walker.Step(position, area, size, .066, true, n * .066); movedX |= Math.Abs(next.X - position.X) > .001; movedY |= Math.Abs(next.Y - position.Y) > .001; position = next; inBounds &= position.X >= area.Left && position.Y >= area.Top && position.X + size.Width <= area.Right && position.Y + size.Height <= area.Bottom; }
            Check("walk-stays-within-work-area", inBounds); Check("walk-uses-both-axes", movedX && movedY);
            pet.Bubble.SetMessage("这是纯合成气泡，用来验证排版。没有读取任何窗口、聊天或账号，也不会发送模型请求。", "local", false);
            pet.Bubble.PrepareSyntheticReply(); Check("bubble-preserves-inline-draft", pet.Bubble.HasDraft);
            Render(pet, Path.Combine(output, "pet.png"), pet.Width, pet.Height);
            Render(pet.Bubble, Path.Combine(output, "bubble.png"), 350, 280);
            pet.Bubble.CompleteReply(); Check("bubble-success-clears-draft", !pet.Bubble.HasDraft);
            foreach (var entry in pet.Views.BuildSyntheticViewsForTest(output)) Check(entry.Key, entry.Value);
            Check("four-synthetic-render-target-images", new[] { "pet.png", "bubble.png", "chat.png", "setup.png" }.All(name => File.Exists(Path.Combine(output, name))));
            Check("no-child-started-by-self-test", !service.IsRunning);
            var report = new { passed = true, kind = "synthetic-wpf-offscreen", checks, screenshots = false, modelRequests = false, accountReads = false, physicalDesktopValidated = false, snapshots = new[] { "pet.png", "bubble.png", "chat.png", "setup.png" } };
            string json = JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(Path.Combine(output, "self-test.json"), json); Console.WriteLine(json); return 0;
        }
        catch (Exception error)
        {
            string json = JsonSerializer.Serialize(new { passed = false, kind = "synthetic-wpf-offscreen", checks, errorType = error.GetType().Name, physicalDesktopValidated = false });
            File.WriteAllText(Path.Combine(output, "self-test.json"), json); Console.WriteLine(json); return 1;
        }
        finally
        {
            pet?.CloseForSelfTest(); if (service != null) service.StopAsync().GetAwaiter().GetResult();
            try { Directory.Delete(root, true); } catch { }
        }
    }

    private static void Render(Window window, string file, double width, double height)
    {
        if (window.Content is not FrameworkElement content) throw new InvalidOperationException("synthetic-content-missing");
        content.Width = width; content.Height = height;
        content.Measure(new Size(width, height)); content.Arrange(new Rect(0, 0, width, height)); content.UpdateLayout();
        var bitmap = new RenderTargetBitmap((int)Math.Ceiling(width), (int)Math.Ceiling(height), 96, 96, PixelFormats.Pbgra32);
        bitmap.Render(content); bitmap.Freeze(); var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using FileStream stream = File.Create(file); encoder.Save(stream);
    }
}
