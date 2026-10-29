using System;
using System.IO;
using System.Text.Json;

namespace WhalePet.Windows;

public sealed class PetSettings
{
    public double? Left { get; set; }
    public double? Top { get; set; }
    public double Height { get; set; } = 180;
    public bool Wandering { get; set; } = true;
    public bool AutomaticActions { get; set; } = true;
    public string? ProactiveCursor { get; set; }
    public bool OnboardingSeen { get; set; }
    public bool ScreenshotsEnabled => false;
    public bool AppInfoEnabled => false;

    public static PetSettings Load(string dataRoot, out string? error)
    {
        error = null;
        string file = Path.Combine(dataRoot, "windows-settings.json");
        if (!File.Exists(file)) return new PetSettings();
        try
        {
            if (new FileInfo(file).Length > 65536) throw new InvalidDataException();
            var value = JsonSerializer.Deserialize<PetSettings>(File.ReadAllText(file)) ?? throw new InvalidDataException();
            if (!double.IsFinite(value.Height) || value.Height < 100 || value.Height > 300) throw new InvalidDataException();
            if (value.Left is double x && !double.IsFinite(x) || value.Top is double y && !double.IsFinite(y)) throw new InvalidDataException();
            return value;
        }
        catch { error = "已有桌宠偏好无法读取；原文件已保留。本次只使用临时默认偏好。"; return new PetSettings(); }
    }

    public bool Save(string dataRoot)
    {
        try
        {
            Directory.CreateDirectory(dataRoot);
            string file = Path.Combine(dataRoot, "windows-settings.json");
            string temporary = file + ".new";
            File.WriteAllText(temporary, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
            File.Move(temporary, file, true);
            return true;
        }
        catch { return false; }
    }
}
