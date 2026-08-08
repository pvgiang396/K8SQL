# k8sql — AI Reference

> File này tự đủ để hiểu kiến trúc k8sql và tiếp tục triển khai — không cần đọc lại toàn bộ lịch sử
> quyết định trong plan gốc. Kế hoạch triển khai đầy đủ (đã duyệt) nằm ở
> `~/.claude/plans/hi-n-t-i-project-k8sctl-parallel-glade.md` trên máy tác giả — file này là bản
> tóm tắt sống, cập nhật theo tiến độ thật.

## Vai trò

k8sql là desktop app đa nền tảng (Windows/macOS/Linux) cho Kubernetes/Rancher Tool Server + SQL
Tool — **kế thừa gần như nguyên vẹn backend của
[k8sctl](https://gitlab.com/pvgiang396/k8sctl)** (68 file controller/service, không có native
addon), thay lớp "vỏ" cài đặt (local server + trình duyệt kiosk-mode + service OS) bằng 1 app Tauri
thật. **k8sctl tiếp tục chạy song song, không bị đụng tới** trong suốt quá trình này.

## Quyết định kiến trúc đã chốt (không lật lại khi code)

1. **Tauri (Rust) + Node.js sidecar**, không phải Electron — RAM/installer nhỏ hơn nhiều, phù hợp
   tool nội bộ chạy nền lâu dài. Đánh đổi: CI phải build trên runner thật của cả 3 OS.
2. **Backend**: `server/legacy/` chứa code port 1:1 từ k8sctl (`controllers/`, `services/`,
   `utils/`, `scripts/lib/{browse-directory,config-info}.js` — 2 file này tạm giữ để
   `settings.service.js` load được, sẽ thay bằng Tauri dialog plugin + SQLite ở Phase 3-5), **không
   sửa logic**. `server/public/` chứa `index.html`/`vendor/codemirror.bundle.js`/`shared/*` — reuse
   nguyên vẹn.
3. **Đóng gói**: Node 22+ Single Executable Application (SEA) — không native addon nên không vướng
   giới hạn SEA. Tauri spawn binary này như sidecar, WebView load `http://127.0.0.1:<port>`.
4. **Config/secret**: SQLite (`node:sqlite`, built-in Node ≥22) cho dữ liệu có cấu trúc + OS
   keychain (crate `keyring` phía Rust) cho giá trị secret thật — **chưa triển khai** (Phase 3).
5. **Port mặc định 4210** (k8sctl dùng 3210) — 2 app chạy song song không xung đột. Dò port trống
   nếu bị chiếm (`src-tauri/src/ports.rs`).
6. **Ngôn ngữ Hybrid**: `server/legacy/**/*.js` giữ nguyên JS; mọi code MỚI (`server/src/**/*.ts`,
   toàn bộ `src-tauri/`) viết TypeScript/Rust. `server/tsconfig.json` có `allowJs: true`.
7. **Ràng buộc cứng — tương thích REST API**: mọi route trong `server/legacy/app.js` phải giữ
   nguyên path/method/request/response so với `k8sctl/app.js` gốc, để `r3workspace/index.js` chỉ
   cần đổi `K8SCTL_URL` → `K8SQL_URL` là chạy được. Route MỚI duy nhất được thêm:
   `POST /internal/shutdown` (graceful shutdown, Tauri gọi trước khi kill sidecar).

## Cấu trúc repo

```
k8sql/
├── src-tauri/              # Rust shell
│   ├── Cargo.toml, tauri.conf.json, build.rs, capabilities/default.json
│   └── src/
│       ├── main.rs         # entry, đăng ký plugin (shell/dialog/autostart), spawn sidecar, graceful shutdown khi đóng cửa sổ
│       ├── sidecar.rs       # Phase 1: spawn_dev() — spawn `node server/src/bootstrap.ts` trực tiếp (CHƯA dùng .sidecar()/externalBin, vì chưa có SEA binary — xem Phase 2)
│       └── ports.rs         # find_available_port(), mặc định DEFAULT_PORT=4210
│   └── binaries/            # (rỗng, .gitkeep) — nơi đặt SEA binary theo target-triple từ Phase 2
│
├── server/
│   ├── package.json         # engines: node >=22
│   ├── tsconfig.json        # allowJs: true, checkJs: false
│   ├── legacy/               # PORT NGUYÊN VẸN từ k8sctl — controllers/, services/, utils/, scripts/lib/, app.js (route table, đã bỏ dotenv.config()/app.listen() cuối file — bootstrap.ts đảm nhiệm)
│   ├── src/bootstrap.ts      # entry mới: đọc --port/--host, require legacy/app, app.listen(), log "K8SQL_READY port=<n>"
│   └── public/                # REUSE NGUYÊN VẸN: index.html, vendor/codemirror.bundle.js, shared/settings-modal.*
│
└── README.md                 # hướng dẫn chạy dev
```

## Trạng thái triển khai theo phase

- [x] **Phase 1** — Node backend port xong, chạy độc lập verify OK qua curl (`/health`, static
  `public/`, 404 handler, `/settings/current` đều đúng như k8sctl gốc khi chưa có config thật;
  `/sql/environments` trả lỗi rõ ràng — đúng kỳ vọng vì chưa có config, không phải bug). Tauri shell
  (`main.rs`/`sidecar.rs`/`ports.rs`/`tauri.conf.json`) **compile sạch** (`cargo check`/`cargo
  build`, 0 warning). **CHƯA verify được `cargo tauri dev` chạy full end-to-end (cửa sổ thật mở +
  load đúng URL sidecar)** — máy dev không có X server/Wayland (`DISPLAY`/`WAYLAND_DISPLAY` rỗng)
  và không có `xvfb-run` cài sẵn (không tự `apt install` khi chưa được yêu cầu). Người dùng cần tự
  chạy `cargo tauri dev` trên máy có GUI thật để xác nhận cửa sổ mở đúng + hiển thị đúng SQL Tool UI
  trước khi coi Phase 1 hoàn tất 100%.
  - Máy dev có `/usr/bin/rustc` 1.75 (apt) che trước `rustup`-managed toolchain (1.94.1) trong
    `PATH` (`/usr/bin` đứng trước `~/.cargo/bin` trong `$PATH`) — phải tự prepend
    `~/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin` khi chạy `cargo`/`cargo tauri` liên
    quan tới `src-tauri/` (`tauri-cli` yêu cầu rustc ≥1.77). Ghi lại đây để phiên sau khỏi debug lại.
  - `tauri.conf.json` **tạm bỏ `bundle.externalBin`** (Phase 1 dùng `spawn_dev()` gọi thẳng `node`,
    chưa có SEA binary) — thêm lại `"externalBin": ["binaries/k8sql-server"]` khi làm Phase 2.
- [ ] **Phase 2** — Đóng gói Node SEA, wire `externalBin`, đổi `sidecar.rs` từ `spawn_dev()` (gọi
  `node` trực tiếp) sang `shell().sidecar("k8sql-server")`.
- [ ] **Phase 3** — SQLite (`server/src/config/db.ts`) + keychain bridge (`src-tauri/src/keychain.rs`,
  crate `keyring`) + `server/src/secrets/{keychainClient,envShim}.ts` + import 1 lần từ k8sctl
  (`server/src/migration/importFromK8sctl.ts`).
- [ ] **Phase 4** — First-run wizard với progress bar % (`window.emit("wizard-progress", ...)`).
- [ ] **Phase 5** — `tauri-plugin-autostart` + `tauri-plugin-dialog` thay hẳn
  `scripts/lib/browse-directory.js`/`config-info.js` (xoá khỏi `legacy/scripts/lib/`), xoá mọi
  script cài đặt bash/PowerShell cũ (không port sang k8sql, xem "Việc KHÔNG port" bên dưới).
- [ ] **Phase 6** — CI 3 runner GitLab (`.gitlab-ci.yml`), build installer 3 nền tảng.
- [ ] **Phase 7** — Smoke-test tương thích API, cập nhật `r3workspace/CLAUDE.md` biết `K8SQL_URL`.

## Việc KHÔNG port sang k8sql (thay thế bởi Tauri, xoá khỏi phạm vi)

`win-service.js`, `install.sh`, `install.ps1`, `ensure-node.sh`, `relocate-and-recreate.sh`,
`apply-settings.sh`/`.ps1`, `apply-env-values.sh`, `install-path.sh`, `wizard.js`/`wizard.html`.
Tính năng "đổi thư mục cài đặt sau khi đã cài" (icon ⚙️ hiện tại) **cắt phạm vi có chủ đích cho
v1** — Tauri cài vào vị trí chuẩn OS, không relocate sau cài.

## Ghi chú môi trường dev (máy tác giả)

- `node -v` → v24 (thoả `>=22`). `rustc`/`cargo` hệ thống (`/usr/bin`) là bản apt cũ (1.75, không
  đủ cho `tauri-cli` yêu cầu ≥1.77) — bản đúng nằm ở `rustup` (`~/.rustup/toolchains/stable-*`,
  1.94.1) nhưng **`PATH` xếp `/usr/bin` trước `~/.cargo/bin`** nên lệnh trần `cargo`/`rustc`/`rustup
  run stable cargo ...` đều vô tình dùng bản apt cũ khi cargo tự shell-out gọi lại `rustc`. Cách né:
  luôn prepend tường minh `PATH="/home/pvgiang396/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin:$PATH"`
  trước khi chạy lệnh `cargo`/`cargo tauri` liên quan tới `src-tauri/`.
- `webkit2gtk-4.1`/`javascriptcoregtk-4.1` dev headers đã có sẵn trên máy (không cần cài thêm cho
  Linux build).

## Đọc thêm

- [`k8sctl/CLAUDE.md`](../k8sctl/CLAUDE.md) (repo `r3workspace`) — tài liệu kiến trúc đầy đủ của
  backend gốc, đối chiếu mỗi khi port/rewrite 1 phần nghiệp vụ để không bỏ sót ràng buộc nghiệp vụ
  thật (PSA/Kyverno cho jump pod, 2 lớp chặn SQL read-only, whitelist method Mongo, v.v).
