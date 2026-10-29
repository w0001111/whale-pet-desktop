#!/bin/bash
# Real AppKit/layout and pure animation probes, using only synthetic fixtures.
# Probe windows remain real NSWindows (isVisible/focus/layout are not mocked),
# but a test-only ordering shim makes them transparent and mouse-pass-through.
# The process network sandbox rejects any request escaping URLProtocol fixtures.
set -euo pipefail
umask 077
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
host_arch="$(uname -m)"
case "$host_arch" in arm64|x86_64) ;; *) echo 'NATIVE_TEST unsupported host architecture' >&2; exit 1 ;; esac
build_dir="$project_dir/build/probes/$host_arch"
mkdir -p "$build_dir/module-cache"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/whale-native-tests.XXXXXX")"
fixture_root="$(cd "$fixture_root" && pwd -P)"
cleanup() {
  # Some intentional error-path fixtures temporarily remove their own access.
  chmod -R u+rwX "$fixture_root" 2>/dev/null || true
  rm -rf "$fixture_root"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
mkdir -p "$fixture_root/home" "$fixture_root/tmp"

cat > "$fixture_root/ProbeVisibility.m" <<'OBJC'
#import <AppKit/AppKit.h>
#import <objc/runtime.h>
static void (*originalAlpha)(id, SEL, CGFloat);
static void (*originalMouse)(id, SEL, BOOL);
static void (*originalOrder)(id, SEL, NSWindowOrderingMode, NSInteger);
static void (*originalFront)(id, SEL, id);
static void (*originalKeyFront)(id, SEL, id);
static void (*originalRegardless)(id, SEL);
static void hideProbeWindow(NSWindow *window) {
    originalAlpha(window, @selector(setAlphaValue:), 0);
    originalMouse(window, @selector(setIgnoresMouseEvents:), YES);
}
static void alpha(id self, SEL selector, CGFloat value) { originalAlpha(self, selector, 0); }
static void mouse(id self, SEL selector, BOOL value) { originalMouse(self, selector, YES); }
static void order(id self, SEL selector, NSWindowOrderingMode mode, NSInteger relative) {
    hideProbeWindow(self); originalOrder(self, selector, mode, relative);
}
static void front(id self, SEL selector, id sender) { hideProbeWindow(self); originalFront(self, selector, sender); }
static void keyFront(id self, SEL selector, id sender) { hideProbeWindow(self); originalKeyFront(self, selector, sender); }
static void regardless(id self, SEL selector) { hideProbeWindow(self); originalRegardless(self, selector); }
__attribute__((constructor)) static void installProbeVisibilityGuard(void) {
    Class cls = [NSWindow class];
    originalAlpha = (void *)method_setImplementation(class_getInstanceMethod(cls, @selector(setAlphaValue:)), (IMP)alpha);
    originalMouse = (void *)method_setImplementation(class_getInstanceMethod(cls, @selector(setIgnoresMouseEvents:)), (IMP)mouse);
    originalOrder = (void *)method_setImplementation(class_getInstanceMethod(cls, @selector(orderWindow:relativeTo:)), (IMP)order);
    originalFront = (void *)method_setImplementation(class_getInstanceMethod(cls, @selector(orderFront:)), (IMP)front);
    originalKeyFront = (void *)method_setImplementation(class_getInstanceMethod(cls, @selector(makeKeyAndOrderFront:)), (IMP)keyFront);
    originalRegardless = (void *)method_setImplementation(class_getInstanceMethod(cls, @selector(orderFrontRegardless)), (IMP)regardless);
}
OBJC
if ! xcrun clang -fobjc-arc -c "$fixture_root/ProbeVisibility.m" -o "$build_dir/ProbeVisibility.o" > "$build_dir/visibility.compile.log" 2>&1; then
  echo 'NATIVE_TEST visibility-guard compilation failed; see build/probes logs' >&2
  exit 1
fi

production=(AppPaths.swift SetupWindow.swift NativePet.swift ActivityContext.swift TaskWindow.swift MemoryWindow.swift
  ScreenshotSettings.swift PetBubble.swift PetEmotion.swift PetActions.swift PetWandering.swift
  ProactiveSettings.swift LocalToolsWindow.swift)
production_paths=()
for source in "${production[@]}"; do production_paths+=("$project_dir/$source"); done
common=(-swift-version 5 -Onone -target "$host_arch-apple-macosx15.0"
  -module-cache-path "$build_dir/module-cache"
  -debug-prefix-map "$project_dir=/build/whale-pet"
  -file-prefix-map "$project_dir=/build/whale-pet")
frameworks=(-framework AppKit -framework Foundation -framework QuartzCore -framework ScreenCaptureKit -framework ImageIO)

run_probe() {
  local name="$1"
  shift
  local state="$fixture_root/$name"
  mkdir -p "$state/data"
  if ! /usr/bin/env -i PATH='/usr/bin:/bin:/usr/sbin:/sbin' LANG='en_US.UTF-8' \
      HOME="$fixture_root/home" CFFIXED_USER_HOME="$fixture_root/home" TMPDIR="$fixture_root/tmp/" \
      WHALE_NATIVE_TEST_ROOT="$state" WHALE_PET_DATA_DIR="$state" WHALE_PET_RESOURCE_DIR="$project_dir" \
      WHALE_PET_PORT='45999' \
      /usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*)' \
      "$build_dir/$name" "$@" > "$build_dir/$name.run.log" 2> "$build_dir/$name.stderr.log"; then
    echo "NATIVE_TEST $name failed; see build/probes logs" >&2
    return 1
  fi
  # The probes emit one summary only; never forward framework or failure logs.
  local summary
  summary="$(/usr/bin/awk '/passed [0-9]+ checks/ {line=$0} END {print line}' "$build_dir/$name.run.log")"
  if [[ -z "$summary" ]]; then echo "NATIVE_TEST $name produced no assertion summary" >&2; return 1; fi
  echo "$summary"
}
compile_full() {
  local name="$1"
  if ! xcrun swiftc "${common[@]}" -DWHALE_NATIVE_TEST -DWHALE_SETUP_TEST "${frameworks[@]}" \
      "${production_paths[@]}" "$project_dir/$name.swift" "$build_dir/ProbeVisibility.o" \
      -o "$build_dir/$name" > "$build_dir/$name.compile.log" 2>&1; then
    echo "NATIVE_TEST $name compilation failed; see build/probes logs" >&2
    return 1
  fi
}

for name in SetupWindowProbe PetActionIntegrationProbe NativeInlineProbe; do
  compile_full "$name"
  if [[ "$name" == PetActionIntegrationProbe ]]; then run_probe "$name" "$project_dir"; else run_probe "$name"; fi
done
if ! xcrun swiftc "${common[@]}" -DWHALE_ACTION_TEST -framework Foundation -framework CoreGraphics -framework ImageIO \
    "$project_dir/PetActions.swift" "$project_dir/PetActionsProbe.swift" -o "$build_dir/PetActionsProbe" > "$build_dir/PetActionsProbe.compile.log" 2>&1; then
  echo 'NATIVE_TEST PetActionsProbe compilation failed; see build/probes logs' >&2
  exit 1
fi
run_probe PetActionsProbe "$fixture_root/tmp"
if ! xcrun swiftc "${common[@]}" -DWHALE_WANDERING_TEST -framework Foundation -framework CoreGraphics \
    "$project_dir/PetWandering.swift" "$project_dir/PetWanderingProbe.swift" -o "$build_dir/PetWanderingProbe" > "$build_dir/PetWanderingProbe.compile.log" 2>&1; then
  echo 'NATIVE_TEST PetWanderingProbe compilation failed; see build/probes logs' >&2
  exit 1
fi
run_probe PetWanderingProbe
echo 'NATIVE_TEST passed 5 isolated probe programs; transparent native windows, synthetic network/data, no capture/login/models/permission changes. Not a visual desktop acceptance test.'
