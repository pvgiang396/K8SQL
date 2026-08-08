// Helper dùng chung — tự dò PATH đúng cho toolchain Rust của rustup, tránh vướng bug đã gặp nhiều
// lần trong phiên dev: `/usr/bin/rustc` (bản apt cũ, không đủ version cho `tauri-cli`) đứng TRƯỚC
// `~/.cargo/bin` trong PATH mặc định của shell, khiến `cargo`/`cargo tauri` tự shell-out gọi nhầm
// rustc cũ. Script build KHÔNG được phép phụ thuộc vào việc user tự prepend PATH tay mỗi lần.

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveRustupToolchainBin() {
  const rustupHome = process.env.RUSTUP_HOME || path.join(os.homedir(), ".rustup");
  const toolchainsDir = path.join(rustupHome, "toolchains");
  if (!fs.existsSync(toolchainsDir)) return null;

  const candidates = fs.readdirSync(toolchainsDir).filter((name) => name.startsWith("stable-"));
  if (candidates.length === 0) return null;

  const bin = path.join(toolchainsDir, candidates[0], "bin");
  return fs.existsSync(bin) ? bin : null;
}

export function buildEnvWithRustToolchain() {
  const toolchainBin = resolveRustupToolchainBin();
  if (!toolchainBin) return process.env;

  return {
    ...process.env,
    PATH: `${toolchainBin}:${process.env.PATH}`,
  };
}

export function runRustTriple() {
  const env = buildEnvWithRustToolchain();
  const output = execSync("rustc -Vv", { env, encoding: "utf8" });
  const match = output.match(/^host:\s*(\S+)$/m);
  if (!match) {
    throw new Error(`Không đọc được target triple từ 'rustc -Vv':\n${output}`);
  }
  return match[1];
}
