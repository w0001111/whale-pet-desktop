#!/usr/bin/env python3
"""Inspect source trees and the actual app/ZIP/DMG bytes before distribution.

No network calls, provider login, model calls, or app launches. Findings contain
only relative path, line, and category; matching text is never emitted. Runtime
data and credential files are rejected by name without reading their contents.
"""

import argparse
import io
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import stat
import subprocess
import sys
import tempfile
import zipfile
import zlib

MAX_FILE_BYTES = 1024 * 1024 * 1024
MAX_ARCHIVE_BYTES = 3 * 1024 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 30000
MAX_ARCHIVE_DEPTH = 3
RULES = [
    ("personal_identity", re.compile(r"\b(?:w(?:y)c|w0{3}1{3})\b", re.I)),
    ("personal_absolute_path", re.compile(r"/(?:Volumes|Users)/[^\s/\x00\"'<>]+", re.I)),
    ("private_server", re.compile(r"\b10[.]8[.]18[.]31\b")),
    ("generation_origin", re.compile(r"exec-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|generated[_-]images", re.I)),
    ("private_codex_origin", re.compile(r"[.]codex[/\\](?:sessions|threads|memories|rollouts)[/\\]", re.I)),
    ("private_harness_origin", re.compile(r"HARNESS_(?:ROOT|HOME|INSTALL_ROOT)|DeepSeekHarness[/\\]", re.I)),
    ("api_key_shape", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b")),
    ("github_token_shape", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{30,})\b")),
    ("jwt_shape", re.compile(r"\beyJ[A-Za-z0-9_-]{12,}[.][A-Za-z0-9_-]{12,}[.][A-Za-z0-9_-]{12,}\b")),
    ("private_key", re.compile(r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----")),
    ("credential_literal", re.compile(r"[\"']?(?:access_?token|refresh_?token|id_?token|api_?key|client_?secret|token)[\"']?\s*[:=]\s*[\"'][^\"'\s]{12,}[\"']", re.I)),
    ("bearer_literal", re.compile(r"\bBearer\s+(?:eyJ[A-Za-z0-9_.-]+|[A-Za-z0-9_-]{24,})\b", re.I)),
]
FORBIDDEN_DIRS = {"data", "evidence", "logs", "log", "screenshots", "captures", "backups", ".codex", ".ssh", ".aws"}
FORBIDDEN_FILES = {"auth.json", "credentials.json", "credentials.sqlite", "chat.json", "memory.json", "service.json", "service.log", ".ds_store"}
ARCHIVE_OTHER = (".tar", ".tar.gz", ".tgz", ".7z", ".rar", ".pkg", ".xip")


class Audit:
    def __init__(self):
        self.findings = set()
        self.files = 0
        self.archives = 0

    def add(self, name, line, category):
        # Filenames are evidence, but terminal control characters are never safe.
        name = "".join(c if c.isprintable() else "?" for c in str(name))[:1000]
        self.findings.add((name, max(1, line), category))

    def forbidden(self, name, directory=False, packaged=False):
        parts = PurePosixPath(str(name).replace("\\", "/")).parts
        if any(p.lower() in FORBIDDEN_DIRS for p in parts):
            self.add(name, 1, "runtime_or_private_path")
            return True
        base = parts[-1].lower() if parts else ""
        if base in FORBIDDEN_FILES or (base.startswith(".env") and base not in {".env.example", ".env.sample"}):
            self.add(name, 1, "credential_or_runtime_file")
            return True
        if packaged and ".git" in parts:
            self.add(name, 1, "repository_metadata_in_package")
            return True
        return False

    def scan_text(self, content, name, binary=False):
        for category, rule in RULES:
            if binary and category == "personal_identity":
                # Three-byte words occur accidentally in compressed/compiler
                # data. The path rule still detects personal build paths in
                # executables; textual source and metadata retain this rule.
                continue
            line = 1
            previous = 0
            for match in rule.finditer(content):
                line += content.count("\n", previous, match.start())
                previous = match.start()
                if category == "credential_literal":
                    value = re.search(r"[\"']([^\"']+)[\"']$", match.group())
                    if value and re.fullmatch(r"SYNTHETIC(?:[-_][A-Z0-9]+)+", value.group(1)):
                        continue  # Explicit, non-credential native/mock fixtures.
                if category == "bearer_literal":
                    value = match.group().split(None, 1)[-1]
                    if re.fullmatch(r"SYNTHETIC(?:[-_][A-Z0-9]+)+", value):
                        continue  # The same narrow placeholder rule, after Bearer.
                self.add(name, line, category)

    def scan_bytes(self, content, name, depth=0):
        self.files += 1
        if len(content) > MAX_FILE_BYTES:
            self.add(name, 1, "file_size_limit_uninspected")
            return
        lower = str(name).lower()
        if lower.endswith(".zip"):
            self.scan_zip(io.BytesIO(content), name, depth + 1)
            return
        if lower.endswith(ARCHIVE_OTHER) or lower.endswith(".dmg"):
            self.add(name, 1, "nested_archive_uninspected")
            return
        if content.startswith(b"\x89PNG\r\n\x1a\n"):
            # Pixel data is compressed image content, not a useful string pool.
            # Inspect all textual/EXIF chunks, including compressed PNG text.
            self.scan_png_metadata(content, name)
            return
        # Scan binary strings too: compiled Swift paths and PNG text are not
        # covered by a source-only grep. Latin-1 preserves byte and line offsets.
        text = content.decode("latin1")
        self.scan_text(text, name, binary=b"\x00" in content)
        if b"\x00" in content:
            self.scan_text(text.replace("\x00", ""), name, binary=True)

    def scan_png_metadata(self, content, name):
        offset = 8
        while offset + 12 <= len(content):
            length = int.from_bytes(content[offset:offset + 4], "big")
            kind = content[offset + 4:offset + 8]
            chunk = content[offset + 8:offset + 8 + length]
            if len(chunk) != length:
                self.add(name, 1, "image_metadata_unreadable")
                return
            try:
                if kind == b"zTXt":
                    data = chunk.split(b"\0", 1)[1][1:]
                    decompressor = zlib.decompressobj()
                    expanded = decompressor.decompress(data, 16 * 1024 * 1024)
                    if decompressor.unconsumed_tail:
                        self.add(name, 1, "image_metadata_limit_uninspected")
                    self.scan_text(expanded.decode("latin1"), name)
                elif kind not in {b"IDAT", b"IHDR", b"IEND", b"PLTE", b"tRNS", b"gAMA", b"cHRM", b"sRGB", b"pHYs"}:
                    # Include unknown ancillary provenance chunks as well as
                    # ordinary text/EXIF; never assume that metadata is public.
                    if kind == b"iTXt" and b"\0\x01\0" in chunk:
                        self.add(name, 1, "compressed_image_metadata_uninspected")
                    self.scan_text(chunk.decode("latin1").replace("\0", ""), name)
            except (ValueError, IndexError, zlib.error):
                self.add(name, 1, "image_metadata_unreadable")
            offset += length + 12

    def scan_zip(self, source, name, depth=1):
        self.archives += 1
        if depth > MAX_ARCHIVE_DEPTH:
            self.add(name, 1, "archive_depth_limit_uninspected")
            return
        try:
            with zipfile.ZipFile(source) as archive:
                entries = archive.infolist()
                if len(entries) > MAX_ARCHIVE_ENTRIES or sum(i.file_size for i in entries) > MAX_ARCHIVE_BYTES:
                    self.add(name, 1, "archive_size_limit_uninspected")
                    return
                seen = set()
                for entry in entries:
                    child = f"{name}!/{entry.filename}"
                    parts = PurePosixPath(entry.filename.replace("\\", "/")).parts
                    if entry.filename.startswith(("/", "\\")) or ".." in parts or re.match(r"^[A-Za-z]:", entry.filename):
                        self.add(child, 1, "unsafe_archive_path")
                        continue
                    if entry.filename in seen:
                        self.add(child, 1, "duplicate_archive_entry")
                    seen.add(entry.filename)
                    if self.forbidden(child, entry.is_dir(), packaged=True):
                        continue
                    if entry.is_dir():
                        continue
                    mode = entry.external_attr >> 16
                    if stat.S_ISLNK(mode):
                        target = archive.read(entry).decode("utf8", errors="replace")
                        self.check_link(target, child)
                        continue
                    if entry.file_size > MAX_FILE_BYTES:
                        self.add(child, 1, "file_size_limit_uninspected")
                        continue
                    self.scan_bytes(archive.read(entry), child, depth)
        except (OSError, ValueError, RuntimeError, zipfile.BadZipFile, NotImplementedError):
            self.add(name, 1, "archive_unreadable")

    def check_link(self, target, name):
        if target == "/Applications":
            return  # Conventional DMG installation shortcut, never followed.
        self.scan_text(target, name)
        if target.startswith(("/", "\\")) or ".." in PurePosixPath(target).parts:
            self.add(name, 1, "external_or_parent_symlink")

    def scan_tree(self, root, label, packaged=False, source=False):
        def walk(folder):
            try:
                children = sorted(folder.iterdir())
            except OSError:
                self.add(f"{label}/{folder.relative_to(root)}", 1, "directory_unreadable")
                return
            for item in children:
                relative = item.relative_to(root).as_posix()
                name = f"{label}/{relative}"
                if source and folder == root and item.name in {".cache", "build", "dist", ".git"}:
                    continue  # Explicit source-export allowlist, never artifacts.
                if item.name == ".git" and not packaged:
                    continue  # Release packages must not contain repository metadata.
                if self.forbidden(name, item.is_dir(), packaged):
                    continue
                try:
                    if item.is_symlink():
                        self.check_link(os.readlink(item), name)
                    elif item.is_dir():
                        walk(item)
                    elif item.is_file():
                        if item.stat().st_size > MAX_FILE_BYTES:
                            self.add(name, 1, "file_size_limit_uninspected")
                        elif item.suffix.lower() == ".dmg":
                            self.scan_dmg(item, name)
                        else:
                            self.scan_bytes(item.read_bytes(), name)
                    else:
                        self.add(name, 1, "non_regular_file")
                except OSError:
                    self.add(name, 1, "file_unreadable")
        walk(root)

    def scan_dmg(self, image, name):
        self.archives += 1
        if sys.platform != "darwin":
            self.add(name, 1, "dmg_requires_macos_uninspected")
            return
        with tempfile.TemporaryDirectory(prefix="whale-release-audit-") as temporary:
            mount = Path(temporary) / "mounted"
            mount.mkdir()
            attached = False
            try:
                result = subprocess.run(["hdiutil", "attach", str(image.resolve()), "-readonly", "-nobrowse", "-noautoopen", "-plist", "-mountpoint", str(mount)], capture_output=True, timeout=90)
                if result.returncode:
                    self.add(name, 1, "dmg_mount_failed_uninspected")
                    return
                attached = True
                plistlib.loads(result.stdout)
                self.scan_tree(mount, f"{name}!", packaged=True)
            except (OSError, ValueError, subprocess.TimeoutExpired):
                self.add(name, 1, "dmg_unreadable")
            finally:
                if attached:
                    result = subprocess.run(["hdiutil", "detach", str(mount), "-quiet"], capture_output=True, timeout=60)
                    if result.returncode:
                        self.add(name, 1, "dmg_detach_failed")

    def scan_target(self, target, label):
        target = Path(target)
        if self.forbidden(label + "/" + target.name, target.is_dir(), packaged=target.suffix.lower() in {".app", ".dmg", ".zip"}):
            return
        if target.is_symlink():
            self.add(label, 1, "symlink_audit_target")
        elif target.is_dir():
            self.scan_tree(target, label, packaged=target.suffix.lower() == ".app")
        elif target.suffix.lower() == ".dmg":
            self.scan_dmg(target, label + "/" + target.name)
        elif target.is_file():
            if target.stat().st_size > MAX_FILE_BYTES:
                self.add(label + "/" + target.name, 1, "file_size_limit_uninspected")
            else:
                self.scan_bytes(target.read_bytes(), label + "/" + target.name)
        else:
            self.add(label, 1, "target_missing")


def self_test():
    with tempfile.TemporaryDirectory(prefix="whale-audit-selftest-") as temporary:
        root = Path(temporary)
        (root / "good.txt").write_text("synthetic fixture; no credentials\nAuthorization: Bearer SYNTHETIC-LOCAL-TEST-TOKEN\n")
        (root / "bad.txt").write_text("first line\n" + "/" + "Users/" + "sample-user" + "/private-file\n")
        (root / "data").mkdir()
        # This file must be rejected by path without being opened.
        (root / "data" / "chat.json").write_text("not parsed")
        with zipfile.ZipFile(root / "artifact.zip", "w") as archive:
            archive.writestr("Test.app/Contents/Resources/key.txt", "s" + "k-" + "A" * 30)
            archive.writestr("../escape", "not extracted")
            link = zipfile.ZipInfo("Test.app/Contents/Resources/link")
            link.create_system = 3
            link.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(link, "../../outside")
        metadata = b"fixture\0\0" + zlib.compress(("/" + "Users/" + "synthetic-user" + "/test").encode())
        png_chunk = len(metadata).to_bytes(4, "big") + b"zTXt" + metadata + b"\0" * 4
        (root / "metadata.png").write_bytes(b"\x89PNG\r\n\x1a\n" + png_chunk)
        audit = Audit()
        audit.scan_target(root, "selftest")
        categories = {item[2] for item in audit.findings}
        if not {"personal_absolute_path", "runtime_or_private_path", "api_key_shape", "unsafe_archive_path", "external_or_parent_symlink"}.issubset(categories):
            raise AssertionError("auditor self-test failed")
        if not any(name.endswith("bad.txt") and line == 2 for name, line, _ in audit.findings):
            raise AssertionError("auditor line-number self-test failed")
        if not any(name.endswith("metadata.png") and category == "personal_absolute_path" for name, _, category in audit.findings):
            raise AssertionError("auditor compressed-metadata self-test failed")
        clean = Audit()
        clean.scan_target(root / "good.txt", "clean")
        if clean.findings:
            raise AssertionError("auditor clean self-test failed")
    print("release audit self-test passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("targets", nargs="*", help="Source directory, built .app, actual .zip and/or .dmg; all are inspected.")
    parser.add_argument("--source", action="append", default=[], metavar="DIR", help="Audit a source-export root excluding only top-level .cache/build/dist/.git. Actual artifacts are still passed as positional targets and inspected fully.")
    parser.add_argument("--json", action="store_true", help="Emit only path/line/category objects and counts.")
    parser.add_argument("--self-test", action="store_true")
    options = parser.parse_args()
    if options.self_test:
        self_test()
        return
    if not options.targets and not options.source:
        parser.error("Pass source and the actual release artifacts explicitly.")
    audit = Audit()
    for index, source in enumerate(options.source, 1):
        root = Path(source)
        if root.is_dir() and not root.is_symlink():
            audit.scan_tree(root, f"source{index}", source=True)
        else:
            audit.add(f"source{index}", 1, "invalid_source_root")
    for index, target in enumerate(options.targets, 1):
        audit.scan_target(target, f"target{index}")
    findings = [{"path": p, "line": line, "category": category} for p, line, category in sorted(audit.findings)]
    if options.json:
        print(json.dumps({"files": audit.files, "archives": audit.archives, "findings": findings}, indent=2))
    else:
        for item in findings:
            print(f"{item['path']}:{item['line']}:{item['category']}")
        print(f"release audit: files={audit.files} archives={audit.archives} findings={len(findings)}")
    raise SystemExit(1 if findings else 0)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("audit:1:interrupted_uninspected", file=sys.stderr)
        raise SystemExit(2)
    except Exception:
        # Exception messages can contain filesystem paths or malformed content.
        print("audit:1:internal_error_uninspected", file=sys.stderr)
        raise SystemExit(2)
