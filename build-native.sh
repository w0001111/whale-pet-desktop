#!/bin/bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")" && pwd)"
build_arch="${WHALE_BUILD_ARCH:-$(uname -m)}"
case "$build_arch" in arm64|x86_64) ;; *) echo 'Unsupported Mac architecture' >&2; exit 1 ;; esac
build_dir="${WHALE_BUILD_DIR:-$project_dir/build/$build_arch}"
mkdir -p "$build_dir" "$build_dir/module-cache"
xcrun swiftc -swift-version 5 -O -whole-module-optimization \
  -target "$build_arch-apple-macosx15.0" \
  -module-cache-path "$build_dir/module-cache" \
  -debug-prefix-map "$project_dir=/build/whale-pet" \
  -file-prefix-map "$project_dir=/build/whale-pet" \
  -framework AppKit -framework Foundation -framework QuartzCore -framework ScreenCaptureKit -framework ImageIO \
  "$project_dir/AppPaths.swift" \
  "$project_dir/SetupWindow.swift" \
  "$project_dir/NativePet.swift" \
  "$project_dir/ActivityContext.swift" \
  "$project_dir/TaskWindow.swift" \
  "$project_dir/MemoryWindow.swift" \
  "$project_dir/ScreenshotSettings.swift" \
  "$project_dir/PetBubble.swift" \
  "$project_dir/PetEmotion.swift" \
  "$project_dir/PetActions.swift" \
  "$project_dir/PetWandering.swift" \
  "$project_dir/ProactiveSettings.swift" \
  "$project_dir/LocalToolsWindow.swift" \
  -o "$build_dir/DesktopWhalePet"
echo "$build_dir/DesktopWhalePet"
