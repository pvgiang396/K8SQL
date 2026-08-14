// Tự cập nhật app từ source (git pull + rebuild + cài lại + tự restart) — nút "Cập nhật" cạnh icon
// "Cấu hình" trên toolbar (public/index.html). Chỉ hợp lý chạy trên đúng máy đang giữ source code
// (máy dev) — KHÔNG hardcode path, đọc qua biến môi trường K8SQL_SOURCE_DIR (rule cross-platform,
// xem CLAUDE.md root). Việc cài `.deb` cần sudo → gọi cmdctl (`POST /exec {sudo:true}`, xem
// cmdctl/CLAUDE.md) thay vì tự chạy `sudo` trực tiếp (sẽ treo chờ mật khẩu tương tác).
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const { execFileSync }: typeof import("node:child_process") = require("node:child_process");
const { spawn }: typeof import("node:child_process") = require("node:child_process");

interface SelfUpdateResult {
  message: string;
  gitPullOutput: string;
}

function resolveBuildEnv(): NodeJS.ProcessEnv {
  // Ghi chú môi trường dev (CLAUDE.md): /usr/bin/rustc (apt, quá cũ cho tauri-cli) đứng trước
  // rustup-managed toolchain trong PATH mặc định — prepend tường minh nếu toolchain đó tồn tại,
  // không giả định luôn có (máy khác có thể đã set PATH đúng sẵn).
  const toolchainBin = path.join(os.homedir(), ".rustup", "toolchains", "stable-x86_64-unknown-linux-gnu", "bin");
  if (!fs.existsSync(toolchainBin)) return process.env;
  return { ...process.env, PATH: `${toolchainBin}:${process.env.PATH || ""}` };
}

function findLatestDeb(sourceDir: string): string {
  const distDir = path.join(sourceDir, "dist", "linux-x64");
  const debFiles = fs.readdirSync(distDir).filter((f) => f.endsWith(".deb"));
  if (debFiles.length === 0) throw new Error(`Không tìm thấy file .deb trong ${distDir} sau khi build.`);
  const withMtime = debFiles.map((f) => {
    const full = path.join(distDir, f);
    return { full, mtime: fs.statSync(full).mtimeMs };
  });
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime[0].full;
}

async function installViaCmdctl(debPath: string): Promise<void> {
  const cmdctlUrl = process.env.CMDCTL_URL || "http://127.0.0.1:3003";
  let healthOk = false;
  try {
    const health = await fetch(`${cmdctlUrl}/health`, { signal: AbortSignal.timeout(2000) });
    healthOk = health.ok;
  } catch {
    healthOk = false;
  }
  if (!healthOk) {
    throw new Error(
      `cmdctl chưa chạy tại ${cmdctlUrl} (cần để cài .deb bằng sudo, không tự sudo trực tiếp) — ` +
        `khởi động cmdctl (\`node app.js\` trong thư mục cmdctl) rồi thử lại.`
    );
  }
  const response = await fetch(`${cmdctlUrl}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: `dpkg -i "${debPath}"`, sudo: true, timeoutMs: 120000 }),
  });
  const body = (await response.json().catch(() => null)) as
    | { success: boolean; message?: string; data?: { exitCode: number; stdout: string; stderr: string } }
    | null;
  if (!response.ok || !body?.success) {
    throw new Error(`cmdctl exec lỗi: ${body?.message || `HTTP ${response.status}`}`);
  }
  if (body.data && body.data.exitCode !== 0) {
    throw new Error(`dpkg -i thoát mã ${body.data.exitCode}: ${body.data.stderr || body.data.stdout}`);
  }
}

// Kill process cũ + relaunch process mới bằng 1 shell script detached, chạy ĐỘC LẬP sau khi HTTP
// response đã trả về — không thể tự kill-rồi-spawn trong CHÍNH tiến trình đang xử lý request này
// (spawn trước khi kill sẽ bị tauri-plugin-single-instance chặn, chỉ activate lại cửa sổ CŨ rồi
// thoát ngay — xem CLAUDE.md "Phase 8"). Đúng thứ tự đã verify trong CLAUDE.md mục "AI dùng k8sql":
// pkill -x theo tên tiến trình (không theo path, tương thích deb/AppImage khác layout) → đợi vài
// giây cho port/single-instance lock giải phóng → relaunch --tray.
//
// 2 bug thật đã gặp + fix, tự verify bằng thực nghiệm (spawn tay + kill tay trước khi tin vào
// script) trước khi tin script này chạy đúng trong luồng self-update thật:
// 1. PHẢI dùng `-9`: `pkill k8sql-server` (SIGTERM mặc định) không kết thúc được sidecar đang xử lý
//    CHÍNH request self-update này — `bootstrap.ts`'s
//    `process.on("SIGTERM", () => server.close(() => process.exit(0)))` chờ `server.close()` tự
//    đóng hết socket keep-alive, có thể treo vô thời hạn nếu client (trình duyệt) chưa đóng kết nối
//    hẳn. `/internal/shutdown` (route khác, Tauri gọi lúc bấm "Exit") né được bug này vì tự
//    `setTimeout(() => process.exit(0), 100)` bất kể `server.close()` — dùng `-9` ở đây để có cùng
//    hiệu quả mà không phải sửa lại SIGTERM handler dùng chung.
// 2. PHẢI dùng `-f` (khớp theo cmdline) cho sidecar, KHÔNG dùng `-x` (khớp theo tên comm,
//    `/proc/<pid>/comm`) — binary SEA (`k8sql-server`) có comm thật là `"MainThread"` (Node tự đặt
//    tên thread chính, không phải tên binary), nên `pkill -x k8sql-server` KHÔNG BAO GIỜ khớp dù
//    process đang sống — hệ quả tự verify được: sidecar cũ sống sót qua pkill, app mới phải tự dò
//    sang port 4211 (ports.rs) thay vì 4210.
// 3. Pattern kill process `k8sql` (Tauri main) PHẢI chấp nhận CẢ 2 dạng cmdline: `/usr/bin/k8sql
//    --tray` (launch qua .desktop/autostart, full path) LẪN `k8sql --tray` (launch qua shell với
//    PATH lookup, argv0 không có path — vd script/AI tự relaunch) — pattern cứng `/k8sql --tray`
//    (yêu cầu dấu `/` ngay trước) bỏ sót trường hợp thứ 2, tự verify bằng thực nghiệm (process
//    launch qua `nohup k8sql --tray &` không bị kill, treo lại vô thời hạn).
// 4. **Bug thật nghiêm trọng nhất** — PHẢI neo `^` đầu pattern: `pkill -9 -f k8sql-server` chạy TỪ
//    BÊN TRONG chính script `bash -c "...pkill -9 -f k8sql-server..."` — cmdline của tiến trình
//    bash ĐANG CHẠY câu lệnh đó cũng CHỨA literal "k8sql-server" (chính là text của lệnh pkill) →
//    pkill tự khớp NGƯỢC vào tiến trình bash cha của chính nó, giết nó giữa chừng → mọi lệnh SAU
//    (kill tray, sleep, relaunch) không bao giờ chạy. Tự verify bằng thực nghiệm: sidecar bị kill
//    đúng (dòng 1 kịp chạy) nhưng tray + relaunch không bao giờ xảy ra, không còn tiến trình
//    `bash -c` nào sống sót để debug tiếp — dấu hiệu rõ ràng của self-kill. Fix: neo `^` bắt cmdline
//    PHẢI BẮT ĐẦU bằng path thật (`[^ ]*k8sql...`) — cmdline `bash -c "sleep 1 ; pkill ..."` bắt
//    đầu bằng "bash -c" (có khoảng trắng ngay sau "bash"), không thể khớp pattern neo `^[^ ]*` yêu
//    cầu KHÔNG có khoảng trắng nào trước khi gặp "k8sql-server"/"k8sql".
function scheduleRespawn(): void {
  const script = [
    "sleep 1",
    "pkill -9 -f '^[^ ]*k8sql-server' || true",
    "pkill -9 -f '^[^ ]*k8sql( --tray)?$' || true",
    "sleep 2",
    "DISPLAY=${DISPLAY:-:0} nohup k8sql --tray >/dev/null 2>&1 &",
  ].join(" ; ");
  const child = spawn("bash", ["-c", script], { detached: true, stdio: "ignore" });
  child.unref();
}

async function runSelfUpdate(): Promise<SelfUpdateResult> {
  if (process.platform !== "linux") {
    throw new Error(
      "Cập nhật tự động hiện chỉ hỗ trợ Linux — trên Windows/macOS tự `git pull` + " +
        "`node scripts/build-cross-platform.mjs` rồi cài file cài đặt thủ công."
    );
  }
  const sourceDir = process.env.K8SQL_SOURCE_DIR;
  if (!sourceDir || !fs.existsSync(path.join(sourceDir, "scripts", "build-cross-platform.mjs"))) {
    throw new Error(
      "Chưa cấu hình K8SQL_SOURCE_DIR (đường dẫn source code k8sql trên máy này) — set biến môi " +
        "trường này trỏ tới thư mục checkout rồi khởi động lại app."
    );
  }

  const gitPullOutput = execFileSync("git", ["-C", sourceDir, "pull"], { encoding: "utf8" });

  execFileSync("node", ["scripts/build-cross-platform.mjs", "--targets", "linux"], {
    cwd: sourceDir,
    env: resolveBuildEnv(),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 5 * 60 * 1000,
  });

  const debPath = findLatestDeb(sourceDir);
  await installViaCmdctl(debPath);

  scheduleRespawn();

  return {
    message: "Đã cập nhật và cài đặt thành công, ứng dụng sẽ tự khởi động lại trong vài giây.",
    gitPullOutput,
  };
}

module.exports = { runSelfUpdate };
