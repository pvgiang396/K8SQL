#!/usr/bin/env node
// Lệnh build duy nhất cho k8sql — tự nhận diện OS hiện tại, build native cho đúng OS đó, thử
// cross-build thêm các OS khác nếu khả thi. Xem Context trong plan
// "k8sql — lệnh build đa nền tảng" (`~/.claude/plans/hi-n-t-i-project-k8sctl-parallel-glade.md`
// trên máy tác giả) để biết root cause/giới hạn kỹ thuật đầy đủ trước khi sửa file này.
//
// Cách dùng:
//   node scripts/build-cross-platform.mjs                  # mặc định theo OS hiện tại
//   node scripts/build-cross-platform.mjs --targets linux,windows,macos

import { buildNative } from "./lib/build-native.mjs";
import { buildWindowsRustViaDocker, buildWindowsSeaSidecar } from "./lib/build-windows-cross.mjs";
import { dispatchGithubBuild } from "./lib/github-actions.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const PLATFORM_ALIASES = { windows: "win32", macos: "darwin", linux: "linux" };
const PLATFORM_OPTIONS = [
  { value: "win32", label: "Windows" },
  { value: "linux", label: "Linux" },
  { value: "darwin", label: "macOS" },
];

function defaultTargetsFor(currentOS) {
  // Linux: thử luôn cả Windows (cross-build qua Docker, xem README/CLAUDE.md về rủi ro). macOS
  // KHÔNG nằm trong mặc định — user phải tự gọi --targets macos mới thấy cảnh báo "không làm
  // được", tránh lệnh mặc định lúc nào cũng in ra 1 dòng cảnh báo không hành động được gì.
  if (currentOS === "linux") return ["linux", "win32"];
  // macOS/Windows: hiện chỉ build native cho chính OS đó — chưa thiết kế cross từ 2 OS này sang
  // OS khác trong phạm vi lần này (xem plan mục "Thiết kế").
  return [currentOS];
}

function parseExplicitTargets() {
  const idx = process.argv.indexOf("--targets");
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1]
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .map((t) => PLATFORM_ALIASES[t] || t);
}

function renderTargetPicker(cursor, selected) {
  process.stdout.write("\x1b[2J\x1b[H");
  console.log("k8sql - Chọn nền tảng cần build");
  console.log("Dùng ↑/↓ để di chuyển, Space để chọn/bỏ chọn, Enter để bắt đầu, Q để thoát.\n");

  for (const [index, option] of PLATFORM_OPTIONS.entries()) {
    const marker = selected.has(option.value) ? "x" : " ";
    const pointer = index === cursor ? "❯" : " ";
    console.log(`${pointer} [${marker}] ${option.label}`);
  }
}

async function selectTargetsInteractively() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return defaultTargetsFor(process.platform);
  }

  const selected = new Set(PLATFORM_OPTIONS.map((option) => option.value));
  let cursor = 0;
  renderTargetPicker(cursor, selected);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
    };

    const finish = (targets) => {
      cleanup();
      resolve(targets);
    };

    const onData = (input) => {
      if (input === "\u0003" || input.toLowerCase() === "q") {
        cleanup();
        reject(new Error("Đã hủy build."));
        return;
      }

      if (input === "\u001b[A" || input === "k") {
        cursor = (cursor + PLATFORM_OPTIONS.length - 1) % PLATFORM_OPTIONS.length;
      } else if (input === "\u001b[B" || input === "j") {
        cursor = (cursor + 1) % PLATFORM_OPTIONS.length;
      } else if (input === " ") {
        const value = PLATFORM_OPTIONS[cursor].value;
        if (selected.has(value)) selected.delete(value);
        else selected.add(value);
      } else if (input === "\r" || input === "\n") {
        if (selected.size === 0) {
          console.log("\nVui lòng chọn ít nhất một nền tảng.");
          renderTargetPicker(cursor, selected);
          return;
        }
        finish(PLATFORM_OPTIONS.filter((option) => selected.has(option.value)).map((option) => option.value));
        return;
      }

      renderTargetPicker(cursor, selected);
    };

    process.stdin.on("data", onData);
  });
}

async function main() {
  const currentOS = process.platform;
  const targets = parseExplicitTargets() ?? (await selectTargetsInteractively());

  console.log(`[build] Máy hiện tại: ${currentOS}. Target sẽ build: ${targets.join(", ")}`);

  const results = {};

  for (const target of targets) {
    if (target === currentOS) {
      console.log(`\n[build] ── Native build cho ${target} ──`);
      results[target] = await buildNative({ platform: target });
      continue;
    }

    if (target === "win32" && currentOS === "linux") {
      console.log(`\n[build] ── Cross-build Windows từ Linux ──`);
      try {
        const seaBinaryPath = await buildWindowsSeaSidecar();
        results.win32 = await buildWindowsRustViaDocker(seaBinaryPath);
      } catch (err) {
        console.error(`\n[build] ✗ Cross-build Windows LỖI: ${err.message}`);
        console.error(
          "[build] Đây là hướng build KHÔNG chính thức (Tauri khuyến nghị build native trên Windows " +
            "thật hoặc CI runner Windows) — nếu lỗi, dùng máy/VM Windows thật hoặc GitLab CI runner " +
            "Windows thay vì cố sửa tiếp hướng Docker này (xem k8sql/CLAUDE.md)."
        );
        results.win32 = { error: err.message };
      }
      continue;
    }

    if (target === "darwin") {
      console.log("\n[build] ── Dispatch GitHub Actions macOS ──");
      results.darwin = dispatchGithubBuild({ projectRoot: REPO_ROOT, targets: ["macos"] });
      continue;
    }

    console.warn(`\n[build] ⚠ Chưa hỗ trợ cross-build "${target}" từ ${currentOS}, bỏ qua.`);
    results[target] = { skipped: true };
  }

  console.log("\n[build] === Tổng kết ===");
  for (const [target, result] of Object.entries(results)) {
    if (result?.error) {
      console.log(`  ✗ ${target}: LỖI — ${result.error}`);
    } else if (result?.skipped) {
      console.log(`  ⚠ ${target}: bỏ qua`);
    } else {
      console.log(`  ✓ ${target}: ${result.files?.length ?? 0} file → ${result.distDir}`);
    }
  }

  const hasFailure = Object.values(results).some((r) => r?.error);
  process.exit(hasFailure ? 1 : 0);
}

main().catch((err) => {
  console.error("[build] Lỗi không mong đợi:", err);
  process.exit(1);
});
