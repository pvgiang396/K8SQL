// Gom luồng build native (Linux/macOS/Windows chạy TRÊN đúng OS đó) thành 1 hàm gọi được — trước
// đây làm thủ công qua 2 lệnh tách rời (`npm run build:sea` trong server/, `cargo tauri build`
// trong src-tauri/) lặp lại nhiều lần trong lúc dev k8sql, giờ gom lại đúng 1 chỗ.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEnvWithRustToolchain, runRustTriple } from "./env.mjs";

const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const SERVER_DIR = path.join(REPO_ROOT, "server");
const SRC_TAURI_DIR = path.join(REPO_ROOT, "src-tauri");

const BUNDLES_BY_PLATFORM = {
  // "appimage" cố tình KHÔNG nằm trong mặc định — bundler AppImage cần `linuxdeploy` + FUSE hoạt
  // động, phụ thuộc môi trường (đã tự gặp lỗi thật trong sandbox dev không có FUSE — "failed to run
  // linuxdeploy" khiến CẢ LỆNH thất bại dù .deb đã build xong). Muốn có AppImage, chạy tay:
  // `cargo tauri build --bundles appimage` trên máy desktop có FUSE thật.
  linux: "deb",
  darwin: "dmg",
  win32: "nsis,msi",
};

const DIST_DIR_NAME_BY_PLATFORM = {
  linux: "linux-x64",
  darwin: "darwin-arm64", // máy Apple Silicon phổ biến nhất hiện nay — đổi tay nếu build trên Intel Mac.
  win32: "windows-x64",
};

export async function buildNative({ platform = process.platform } = {}) {
  if (platform !== process.platform) {
    throw new Error(
      `buildNative() chỉ build ĐÚNG platform đang chạy (${process.platform}), không tự cross-build ${platform} kiểu này — dùng buildWindowsCrossFromLinux() cho Windows-từ-Linux.`
    );
  }

  console.log(`\n[build-native] === Bước 1/4: đóng gói Node SEA (server/) ===`);
  execFileSync("npm", ["run", "build:sea"], { cwd: SERVER_DIR, stdio: "inherit" });

  const env = buildEnvWithRustToolchain();
  const triple = runRustTriple();
  const seaBinaryName = platform === "win32" ? "k8sql-server.exe" : "k8sql-server";
  const seaBinarySrc = path.join(SERVER_DIR, "build", seaBinaryName);
  const binariesDir = path.join(SRC_TAURI_DIR, "binaries");
  fs.mkdirSync(binariesDir, { recursive: true });
  const seaBinaryDest = path.join(
    binariesDir,
    `k8sql-server-${triple}${platform === "win32" ? ".exe" : ""}`
  );

  console.log(`\n[build-native] === Bước 2/4: copy binary SEA -> ${seaBinaryDest} ===`);
  fs.copyFileSync(seaBinarySrc, seaBinaryDest);
  if (platform !== "win32") fs.chmodSync(seaBinaryDest, 0o755);

  const bundles = BUNDLES_BY_PLATFORM[platform];
  console.log(`\n[build-native] === Bước 3/4: cargo tauri build --bundles ${bundles} ===`);
  execFileSync("cargo", ["tauri", "build", "--bundles", bundles], {
    cwd: SRC_TAURI_DIR,
    stdio: "inherit",
    env,
  });

  console.log(`\n[build-native] === Bước 4/4: copy artifact ra dist/ ===`);
  const distSubdir = DIST_DIR_NAME_BY_PLATFORM[platform];
  const distDir = path.join(REPO_ROOT, "dist", distSubdir);
  fs.mkdirSync(distDir, { recursive: true });

  const bundleRoot = path.join(SRC_TAURI_DIR, "target", "release", "bundle");
  const copied = [];
  for (const kind of fs.existsSync(bundleRoot) ? fs.readdirSync(bundleRoot) : []) {
    const kindDir = path.join(bundleRoot, kind);
    if (!fs.statSync(kindDir).isDirectory()) continue;
    for (const entry of fs.readdirSync(kindDir)) {
      const entryPath = path.join(kindDir, entry);
      if (fs.statSync(entryPath).isFile()) {
        const dest = path.join(distDir, entry);
        fs.copyFileSync(entryPath, dest);
        copied.push(dest);
      }
    }
  }

  console.log(`[build-native] Xong. File đã copy vào ${distDir}:`);
  for (const f of copied) console.log(`  - ${f}`);

  return { distDir, files: copied };
}
