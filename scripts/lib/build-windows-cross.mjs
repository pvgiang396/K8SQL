// Cross-build Windows TỪ Linux — 2 bước tách biệt rõ ràng theo đúng root cause đã xác minh (xem
// Context trong plan "k8sql — lệnh build đa nền tảng"):
//   1. SEA sidecar Node cho Windows — KHÔNG cần Docker, chỉ cần binary `node.exe` Windows THẬT (tải
//      từ nodejs.org, không cần CHẠY nó) làm nơi `postject` tiêm blob vào (postject là module WASM
//      portable, tự nhận diện định dạng PE/ELF/Mach-O từ magic bytes của chính file, không phụ
//      thuộc process.platform — đã tự đọc dist/api.js xác nhận trước khi viết phần này).
//   2. Vỏ Tauri/Rust (GUI + trình cài NSIS) — THẬT SỰ cần cross-compile qua Docker (mingw-w64), xem
//      buildWindowsRustViaDocker() trong file docker-build.mjs.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuildBuild } from "esbuild";

const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const SERVER_DIR = path.join(REPO_ROOT, "server");
const CACHE_DIR = path.join(REPO_ROOT, ".cache");

function readNodeEngineVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, "package.json"), "utf8"));
  // "engines": {"node": ">=22.0.0"} — SEA cần 1 version CỤ THỂ để tải node.exe, không chỉ range.
  // Dùng version Node đang chạy chính script này làm mặc định (thường đã ≥22 trên máy dev), cho
  // phép override qua biến môi trường K8SQL_WIN_NODE_VERSION nếu cần pin khác.
  void pkg; // giữ lại để dễ mở rộng sau (validate range) — hiện chỉ cần biết field tồn tại.
  return process.env.K8SQL_WIN_NODE_VERSION || process.versions.node;
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          file.close();
          fs.unlinkSync(destPath);
          downloadFile(res.headers.location, destPath).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(destPath);
          reject(new Error(`Tải ${url} thất bại: HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", (err) => {
        file.close();
        fs.rmSync(destPath, { force: true });
        reject(err);
      });
  });
}

async function ensureWindowsNodeBinary(version) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cached = path.join(CACHE_DIR, `node-v${version}-win-x64.exe`);
  if (fs.existsSync(cached)) {
    console.log(`[build-windows-cross] Dùng node.exe đã cache: ${cached}`);
    return cached;
  }

  const url = `https://nodejs.org/dist/v${version}/win-x64/node.exe`;
  console.log(`[build-windows-cross] Tải ${url} ...`);
  await downloadFile(url, cached);
  console.log(`[build-windows-cross] Đã tải xong: ${cached}`);
  return cached;
}

function isValidPE(filePath) {
  // Kiểm tra nhanh magic bytes PE (MZ header + PE\0\0 signature ở offset trỏ bởi e_lfanew) — xác
  // nhận postject tiêm xong vẫn là file PE hợp lệ, không cần cài `file` command (không có sẵn mọi
  // môi trường CI).
  const buf = fs.readFileSync(filePath);
  if (buf.length < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) return false; // "MZ"
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset + 4 > buf.length) return false;
  return buf[peOffset] === 0x50 && buf[peOffset + 1] === 0x45 && buf[peOffset + 2] === 0 && buf[peOffset + 3] === 0; // "PE\0\0"
}

export async function buildWindowsSeaSidecar() {
  const version = readNodeEngineVersion();
  console.log(`\n[build-windows-cross] === SEA sidecar cho Windows (Node v${version}) ===`);

  const winNodeExe = await ensureWindowsNodeBinary(version);

  const buildDir = path.join(SERVER_DIR, "build-win");
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });

  const bundlePath = path.join(buildDir, "bundle.js");
  console.log("[build-windows-cross] esbuild bundle (platform-agnostic, giống build-sea.mjs)...");
  await esbuildBuild({
    entryPoints: [path.join(SERVER_DIR, "src", "bootstrap.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: bundlePath,
    alias: {
      "optional-require": path.join(SERVER_DIR, "scripts", "shims", "optional-require.cjs"),
    },
  });

  fs.cpSync(path.join(SERVER_DIR, "public"), path.join(buildDir, "public"), { recursive: true });

  const seaConfigPath = path.join(buildDir, "sea-config.json");
  const blobPath = path.join(buildDir, "sea-prep.blob");
  fs.writeFileSync(
    seaConfigPath,
    JSON.stringify({ main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true }, null, 2)
  );

  console.log("[build-windows-cross] node --experimental-sea-config (chạy Node local, không cần Windows)...");
  execFileSync(process.execPath, ["--experimental-sea-config", seaConfigPath], { stdio: "inherit" });

  const outBinaryPath = path.join(buildDir, "k8sql-server.exe");
  fs.copyFileSync(winNodeExe, outBinaryPath);

  console.log("[build-windows-cross] postject: tiêm blob vào node.exe Windows (chạy trên Linux)...");
  const postjectBin = path.join(REPO_ROOT, "node_modules", ".bin", "postject");
  execFileSync(
    postjectBin,
    [
      outBinaryPath,
      "NODE_SEA_BLOB",
      blobPath,
      "--sentinel-fuse",
      "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ],
    { stdio: "inherit" }
  );

  if (!isValidPE(outBinaryPath)) {
    throw new Error(
      `[build-windows-cross] File ${outBinaryPath} sau khi tiêm KHÔNG còn là PE hợp lệ (magic bytes sai) — postject có thể không hỗ trợ tiêm PE khi chạy trên Linux như giả định, cần điều tra lại.`
    );
  }
  console.log(`[build-windows-cross] Xác nhận ${outBinaryPath} là file PE32+ hợp lệ.`);

  return outBinaryPath;
}

const DOCKER_IMAGE_TAG = "k8sql-windows-cross";
const WIN_TARGET_TRIPLE = "x86_64-pc-windows-gnu";

function ensureDockerImage() {
  console.log(`\n[build-windows-cross] docker build -t ${DOCKER_IMAGE_TAG} (lần đầu có thể mất vài phút)...`);
  execFileSync(
    "docker",
    ["build", "-t", DOCKER_IMAGE_TAG, "-f", path.join(REPO_ROOT, "docker", "windows-cross.Dockerfile"), REPO_ROOT],
    { stdio: "inherit" }
  );
}

// Tauri's externalBin resolve tên sidecar THEO ĐÚNG target triple đang build — container cross-
// compile bằng target GNU (`x86_64-pc-windows-gnu`), không phải MSVC (`x86_64-pc-windows-msvc`)
// mà build native thật trên máy Windows sẽ dùng — nên phải đặt tên binary SEA theo ĐÚNG triple GNU
// ở đây, khác tên khi build native trên Windows thật (không đụng nhau, 2 file riêng biệt).
export async function buildWindowsRustViaDocker(seaBinaryPath) {
  console.log(`\n[build-windows-cross] === Cross-compile Tauri/Rust cho Windows qua Docker (RỦI RO CAO, thử nghiệm) ===`);

  ensureDockerImage();

  const binariesDir = path.join(REPO_ROOT, "src-tauri", "binaries");
  fs.mkdirSync(binariesDir, { recursive: true });
  fs.copyFileSync(seaBinaryPath, path.join(binariesDir, `k8sql-server-${WIN_TARGET_TRIPLE}.exe`));

  const cargoRegistryVolume = "k8sql-windows-cross-cargo-registry";
  const cargoTargetVolume = "k8sql-windows-cross-target";
  const userInfo = os.userInfo();

  // Bug thật đã tự gặp: named volume MỚI (chưa từng mount) kế thừa ownership từ thư mục gốc trong
  // image (`/usr/local/cargo` trong `rust:1-bookworm` thuộc root) — nên lần build ĐẦU TIÊN sau khi
  // đổi sang `--user uid:gid` (bên dưới) sẽ luôn lỗi "Permission denied" khi cargo cố ghi cache/
  // target. Chown volume về đúng user host TRƯỚC mỗi lần build (container tạm dùng alpine, idempotent
  // — chown lại volume đã đúng owner không gây hại gì) để tự sửa, không bắt user tự chạy tay lệnh
  // `docker run --rm -v ...:/x alpine chown -R uid:gid /x` như đã phải làm thủ công lúc điều tra bug.
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${cargoRegistryVolume}:/reg`,
      "-v",
      `${cargoTargetVolume}:/tgt`,
      "alpine",
      "chown",
      "-R",
      `${userInfo.uid}:${userInfo.gid}`,
      "/reg",
      "/tgt",
    ],
    { stdio: "inherit" }
  );

  const distDir = path.join(REPO_ROOT, "dist", "windows-x64");
  fs.mkdirSync(distDir, { recursive: true });

  // `target/` bên trong container nằm ở Docker NAMED VOLUME (để cache biên dịch giữa các lần chạy,
  // nhanh hơn hẳn so với bind-mount trực tiếp) — host KHÔNG đọc trực tiếp được named volume. Bug
  // thật đã tự gặp: build "thành công" bên trong container (log có dòng "Finished 1 bundle at:
  // .../k8sql_0.1.0_x64-setup.exe") nhưng script không tìm thấy file trên host vì đi tìm nhầm chỗ.
  // Fix: để CHÍNH container tự copy kết quả ra `/work/dist/windows-x64` — `/work` là bind-mount
  // thật (REPO_ROOT trên host), nên copy vào đó = ghi thẳng lên đĩa host, không cần host tự dò tìm
  // trong volume nữa.
  console.log("[build-windows-cross] docker run cargo tauri build --target " + WIN_TARGET_TRIPLE + " ...");
  const bundleDirInContainer = `/work/src-tauri/target/${WIN_TARGET_TRIPLE}/release/bundle/nsis`;
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      // Chạy container bằng ĐÚNG uid:gid của user host — tránh sinh file "root"-owned trong thư
      // mục bind-mount (bug thật đã gặp lần build đầu: `.exe` sinh ra thuộc root, cần sudo mới
      // xoá/sửa được, không đúng tinh thần "tránh dùng sudo khi không cần thiết").
      "--user",
      `${userInfo.uid}:${userInfo.gid}`,
      "-v",
      `${REPO_ROOT}:/work`,
      "-v",
      `${cargoRegistryVolume}:/usr/local/cargo/registry`,
      "-v",
      `${cargoTargetVolume}:/work/src-tauri/target`,
      // Container chạy non-root cần HOME ghi được — /usr/local/cargo (registry) đã mount riêng,
      // set thêm CARGO_HOME/HOME trỏ vào đó để cargo không cố ghi vào $HOME mặc định (thường là
      // /nonexistent hoặc không ghi được khi chạy bằng uid lạ chưa có entry /etc/passwd).
      "-e",
      "HOME=/tmp",
      "-w",
      "/work/src-tauri",
      DOCKER_IMAGE_TAG,
      "sh",
      "-c",
      `cargo tauri build --target ${WIN_TARGET_TRIPLE} --bundles nsis && mkdir -p /work/dist/windows-x64 && cp ${bundleDirInContainer}/*.exe /work/dist/windows-x64/`,
    ],
    { stdio: "inherit" }
  );

  const copied = fs.existsSync(distDir)
    ? fs
        .readdirSync(distDir)
        .map((entry) => path.join(distDir, entry))
        .filter((p) => fs.statSync(p).isFile())
    : [];

  if (copied.length === 0) {
    throw new Error(
      `[build-windows-cross] Docker build "thành công" nhưng không thấy file cài đặt nào ở ${distDir} — kiểm tra log Docker phía trên.`
    );
  }

  console.log(`[build-windows-cross] Xong. File đã copy vào ${distDir}:`);
  for (const f of copied) console.log(`  - ${f}`);
  return { distDir, files: copied };
}
