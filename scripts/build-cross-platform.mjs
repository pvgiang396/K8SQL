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

const PLATFORM_ALIASES = { windows: "win32", macos: "darwin", linux: "linux" };

function parseTargets() {
  const idx = process.argv.indexOf("--targets");
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1]
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .map((t) => PLATFORM_ALIASES[t] || t);
}

function defaultTargetsFor(currentOS) {
  // Linux: thử luôn cả Windows (cross-build qua Docker, xem README/CLAUDE.md về rủi ro). macOS
  // KHÔNG nằm trong mặc định — user phải tự gọi --targets macos mới thấy cảnh báo "không làm
  // được", tránh lệnh mặc định lúc nào cũng in ra 1 dòng cảnh báo không hành động được gì.
  if (currentOS === "linux") return ["linux", "win32"];
  // macOS/Windows: hiện chỉ build native cho chính OS đó — chưa thiết kế cross từ 2 OS này sang
  // OS khác trong phạm vi lần này (xem plan mục "Thiết kế").
  return [currentOS];
}

async function main() {
  const currentOS = process.platform;
  const targets = parseTargets() ?? defaultTargetsFor(currentOS);

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
      console.warn(
        "\n[build] ⚠ Bỏ qua macOS — KHÔNG thể cross-build qua Docker (Apple không cho phép chạy " +
          "Xcode/SDK macOS trên phần cứng không phải Apple, đây là giới hạn pháp lý + kỹ thuật, " +
          "không phải thiếu cấu hình). Cần máy Mac thật hoặc CI runner macOS (xem k8sql/CLAUDE.md)."
      );
      results.darwin = { skipped: true };
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
