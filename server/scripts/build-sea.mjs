// Đóng gói server/ thành 1 binary Node 22 Single Executable Application (SEA) — xem "Sidecar
// packaging" trong plan k8sql. Phải chạy TRÊN đúng OS/arch đích (SEA không cross-compile được),
// bằng đúng phiên bản `node` sẽ làm base binary.
//
// Output: server/build/k8sql-server[.exe] + server/build/public/ (sibling, để test standalone).
// Bước đổi tên theo target-triple (`k8sql-server-<triple>`) + copy vào src-tauri/binaries/ KHÔNG
// nằm trong script này — đó là bước riêng (CI hoặc thủ công) vì cần biết Rust target triple, script
// này chỉ lo phần thuần Node.

import { build as esbuildBuild } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(serverDir, "build");
const bundlePath = path.join(buildDir, "bundle.js");
const seaConfigPath = path.join(buildDir, "sea-config.json");
const blobPath = path.join(buildDir, "sea-prep.blob");
const outBinaryName = process.platform === "win32" ? "k8sql-server.exe" : "k8sql-server";
const outBinaryPath = path.join(buildDir, outBinaryName);

fs.rmSync(buildDir, { recursive: true, force: true });
fs.mkdirSync(buildDir, { recursive: true });

console.log("[1/6] esbuild bundle server/src/bootstrap.ts -> build/bundle.js");
await esbuildBuild({
  entryPoints: [path.join(serverDir, "src", "bootstrap.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: bundlePath,
  // legacy/**/*.js được kéo vào qua chuỗi require() từ bootstrap.ts -> legacy/app.js -> controllers/services.
  // node: builtin (kể cả node:sea) tự động external khi platform=node — không cần khai tường minh.
  alias: {
    // mongodb-legacy-driver dùng optional-require (eval("require") — không bundle tĩnh được, và
    // require runtime bị SEA chặn nếu không phải built-in). Thay bằng shim static-require riêng
    // cho SEA — xem comment đầu file shim để biết root cause đầy đủ.
    "optional-require": path.join(serverDir, "scripts", "shims", "optional-require.cjs"),
  },
});

console.log("[2/6] copy server/public -> build/public (thư mục sibling cạnh binary)");
fs.cpSync(path.join(serverDir, "public"), path.join(buildDir, "public"), { recursive: true });

console.log("[3/6] tạo sea-config.json");
fs.writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
    },
    null,
    2
  )
);

console.log("[4/6] node --experimental-sea-config sea-config.json");
execFileSync(process.execPath, ["--experimental-sea-config", seaConfigPath], { stdio: "inherit" });

console.log(`[5/6] copy node binary (${process.execPath}) -> build/${outBinaryName}`);
fs.copyFileSync(process.execPath, outBinaryPath);
fs.chmodSync(outBinaryPath, 0o755);

console.log("[6/6] postject: nhúng blob vào binary");
const postjectBin = path.join(serverDir, "node_modules", ".bin", "postject");
const postjectArgs = [
  outBinaryPath,
  "NODE_SEA_BLOB",
  blobPath,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
];
if (process.platform === "darwin") {
  postjectArgs.push("--macho-segment-name", "NODE_SEA");
}
execFileSync(postjectBin, postjectArgs, { stdio: "inherit" });

if (process.platform === "darwin") {
  console.log("[macOS] ký ad-hoc sau khi postject (bắt buộc để binary chạy được sau khi bị patch)");
  execFileSync("codesign", ["--sign", "-", outBinaryPath], { stdio: "inherit" });
}

console.log(`\nXong: ${outBinaryPath}`);
console.log("Test standalone: cd build && ./" + outBinaryName + " --port 4210");
