using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace WhalePet.Windows;

public sealed class PetAnimator
{
    private sealed record Frame(BitmapSource Image, byte[] Pixels);
    private sealed record Clip(string Id, Frame[] Frames, double Fps, bool Loop);
    private sealed record Step(string Clip, double Duration);
    private readonly Dictionary<string, Clip> _clips = new(StringComparer.Ordinal);
    private readonly List<Frame> _idle = new();
    private readonly List<Step> _steps = new();
    private double _started, _manualUntil;
    private bool _continuous;
    private Frame? _current;
    public BitmapSource? CurrentFrame => _current?.Image;
    public string CurrentClip { get; private set; } = "idle";
    public string Emotion { get; set; } = "idle";
    public bool IsWalking => CurrentClip == "walk" && _continuous;
    public bool IsExclusive(double now) => now < _manualUntil;
    public int ClipCount => _clips.Count;
    public string? LoadError { get; private set; }
    public IReadOnlyCollection<string> ClipIds => _clips.Keys;

    public PetAnimator(string assetRoot)
    {
        try
        {
            string sprite = Path.Combine(assetRoot, "pet-sprites.png");
            if (File.Exists(sprite))
            {
                BitmapSource sheet = LoadImage(sprite);
                int size = Math.Min(sheet.PixelWidth / 2, sheet.PixelHeight / 2);
                for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) _idle.Add(Crop(sheet, new Int32Rect(x * size, y * size, size, size)));
            }
            else _idle.Add(FrameFrom(LoadImage(Path.Combine(assetRoot, "pet.png"))));
            LoadClips(Path.Combine(assetRoot, "actions-v2"));
        }
        catch { LoadError = "动作素材不完整，已保留可加载的离线角色。"; }
        _current = _idle.FirstOrDefault() ?? _clips.Values.FirstOrDefault()?.Frames.FirstOrDefault();
    }

    private static BitmapSource LoadImage(string path)
    {
        if (!File.Exists(path) || new FileInfo(path).Length > 24 * 1024 * 1024) throw new InvalidDataException();
        var source = new BitmapImage(); source.BeginInit(); source.CacheOption = BitmapCacheOption.OnLoad;
        source.UriSource = new Uri(Path.GetFullPath(path)); source.EndInit(); source.Freeze();
        if (source.PixelWidth is <= 0 or > 4096 || source.PixelHeight is <= 0 or > 4096) throw new InvalidDataException();
        return source;
    }
    private static Frame FrameFrom(BitmapSource image)
    {
        var value = new FormatConvertedBitmap(image, PixelFormats.Bgra32, null, 0); value.Freeze();
        byte[] pixels = new byte[value.PixelWidth * value.PixelHeight * 4];
        value.CopyPixels(pixels, value.PixelWidth * 4, 0); return new Frame(value, pixels);
    }
    private static Frame Crop(BitmapSource source, Int32Rect region)
    {
        if (region.Width <= 0 || region.Height <= 0 || region.X < 0 || region.Y < 0 || region.X + region.Width > source.PixelWidth || region.Y + region.Height > source.PixelHeight) throw new InvalidDataException();
        var cropped = new CroppedBitmap(source, region); cropped.Freeze(); return FrameFrom(cropped);
    }
    private void LoadClips(string directory)
    {
        string file = Path.Combine(directory, "manifest.json");
        if (new FileInfo(file).Length > 128 * 1024) throw new InvalidDataException();
        JsonNode data = JsonNode.Parse(File.ReadAllText(file)) ?? throw new InvalidDataException();
        if (data["version"]?.GetValue<int>() != 1) throw new InvalidDataException();
        var sheets = new Dictionary<string, Frame[]>(StringComparer.Ordinal);
        foreach (JsonNode? item in data["sheets"]?.AsArray() ?? throw new InvalidDataException())
        {
            string id = item?["id"]?.GetValue<string>() ?? throw new InvalidDataException();
            string name = item["file"]?.GetValue<string>() ?? throw new InvalidDataException();
            if (name != Path.GetFileName(name) || !name.EndsWith(".png", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException();
            BitmapSource image = LoadImage(Path.Combine(directory, name));
            int columns = item["columns"]?.GetValue<int>() ?? 1, rows = item["rows"]?.GetValue<int>() ?? 1;
            if (columns is < 1 or > 12 || rows is < 1 or > 12) throw new InvalidDataException();
            JsonArray? regions = item["regions"] as JsonArray;
            var frames = new List<Frame>();
            for (int index = 0; index < columns * rows; index++)
            {
                Int32Rect rect;
                if (regions != null)
                { var r = regions[index]?.AsArray() ?? throw new InvalidDataException(); rect = new Int32Rect(r[0]!.GetValue<int>(), r[1]!.GetValue<int>(), r[2]!.GetValue<int>(), r[3]!.GetValue<int>()); }
                else rect = new Int32Rect(index % columns * (image.PixelWidth / columns), index / columns * (image.PixelHeight / rows), image.PixelWidth / columns, image.PixelHeight / rows);
                frames.Add(Crop(image, rect));
            }
            sheets.Add(id, frames.ToArray());
        }
        foreach (JsonNode? item in data["clips"]?.AsArray() ?? throw new InvalidDataException())
        {
            string id = item?["id"]?.GetValue<string>() ?? throw new InvalidDataException();
            string sheet = item["sheet"]!.GetValue<string>();
            double fps = item["fps"]!.GetValue<double>();
            if (!double.IsFinite(fps) || fps < .5 || fps > 30) throw new InvalidDataException();
            Frame[] frames = item["frames"]!.AsArray().Select(index => sheets[sheet][index!.GetValue<int>()]).ToArray();
            if (frames.Length is < 1 or > 64) throw new InvalidDataException();
            _clips.Add(id, new Clip(id, frames, fps, item["loop"]!.GetValue<bool>()));
        }
    }

    private double Cycle(string id) => _clips.TryGetValue(id, out Clip? clip) ? clip.Frames.Length / clip.Fps : .75;
    public bool PlayAction(string id, double now, double duration = 8)
    {
        if (!_clips.ContainsKey(id)) return false;
        _steps.Clear(); _continuous = false; _started = now;
        if (id is "standUp" or "walk") _steps.Add(new Step("standUp", Cycle("standUp")));
        if (id == "standUp") _steps.Add(new Step("stand", Math.Max(1, duration)));
        else _steps.Add(new Step(id, id == "sitDown" ? Cycle(id) : Math.Max(1, duration)));
        if (id is "standUp" or "stand" or "walk") _steps.Add(new Step("sitDown", Cycle("sitDown")));
        _manualUntil = now + _steps.Sum(step => step.Duration); return true;
    }
    public void SetWalking(bool enabled, double now)
    {
        if (IsExclusive(now) || enabled == _continuous) return;
        _steps.Clear(); _started = now; _continuous = enabled;
        if (enabled) { _steps.Add(new Step("standUp", Cycle("standUp"))); _steps.Add(new Step("walk", double.PositiveInfinity)); }
        else { _steps.Add(new Step("stand", .35)); _steps.Add(new Step("sitDown", Cycle("sitDown"))); }
    }
    public bool Update(double now, bool reducedMotion = false)
    {
        Frame? previous = _current; double elapsed = Math.Max(0, now - _started);
        foreach (Step step in _steps)
        {
            if (elapsed < step.Duration && _clips.TryGetValue(step.Clip, out Clip? clip))
            {
                int index = reducedMotion ? 0 : (int)Math.Floor(elapsed * clip.Fps);
                index = clip.Loop ? index % clip.Frames.Length : Math.Min(index, clip.Frames.Length - 1);
                _current = clip.Frames[Math.Max(0, index)]; CurrentClip = clip.Id; return !ReferenceEquals(previous, _current);
            }
            elapsed -= step.Duration;
        }
        _steps.Clear(); CurrentClip = "idle";
        if (_idle.Count > 0)
        {
            int index = !reducedMotion && now % 5.5 < .14 ? Math.Min(1, _idle.Count - 1) : 0;
            _current = _idle[index];
        }
        return !ReferenceEquals(previous, _current);
    }
    public bool OpaqueAt(Point point, Size viewport)
    {
        if (_current == null || viewport.Width <= 0 || viewport.Height <= 0) return false;
        double scale = Math.Min(viewport.Width / _current.Image.PixelWidth, viewport.Height / _current.Image.PixelHeight);
        double x = (point.X - (viewport.Width - _current.Image.PixelWidth * scale) / 2) / scale;
        double y = (point.Y - (viewport.Height - _current.Image.PixelHeight * scale) / 2) / scale;
        if (x < 0 || y < 0 || x >= _current.Image.PixelWidth || y >= _current.Image.PixelHeight) return false;
        return _current.Pixels[((int)y * _current.Image.PixelWidth + (int)x) * 4 + 3] >= 30;
    }
}

/// Pure two-dimensional planning; no mouse/window reads and no AI.
public sealed class PetWalker
{
    private readonly Random _random;
    private Point? _target;
    private double _restUntil;
    public bool WantsWalking => _target != null;
    public PetWalker(int? seed = null) { _random = seed is int value ? new Random(value) : new Random(); }
    public void Reset() { _target = null; _restUntil = 0; }
    public static Point Clamp(Point point, Rect area, Size pet) => new(Math.Clamp(point.X, area.Left, Math.Max(area.Left, area.Right - pet.Width)), Math.Clamp(point.Y, area.Top, Math.Max(area.Top, area.Bottom - pet.Height)));
    public void Prepare(Point current, Rect area, Size pet, double now)
    {
        if (_target != null || now < _restUntil) return;
        double width = Math.Max(0, area.Width - pet.Width), height = Math.Max(0, area.Height - pet.Height);
        Point candidate = Clamp(new Point(area.Left + _random.NextDouble() * width, area.Top + _random.NextDouble() * height), area, pet);
        if ((candidate - current).Length < 20) { _restUntil = now + 3; return; }
        _target = candidate;
    }
    public Point Step(Point current, Rect area, Size pet, double seconds, bool mayMove, double now)
    {
        current = Clamp(current, area, pet);
        if (!mayMove || _target == null) return current;
        Vector vector = Clamp(_target.Value, area, pet) - current;
        double distance = vector.Length, step = Math.Min(distance, Math.Clamp(seconds, 0, .1) * 32);
        if (distance < 1 || step >= distance) { Point result = Clamp(_target.Value, area, pet); _target = null; _restUntil = now + 4 + _random.NextDouble() * 9; return result; }
        vector.Normalize(); return Clamp(current + vector * step, area, pet);
    }
}
