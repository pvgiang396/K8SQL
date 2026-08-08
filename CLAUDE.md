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
   giới hạn SEA. Tauri spawn binary này như sidecar, WebView load `http://127.0.0.1:<port>`. **Đã
   triển khai xong (Phase 2)** — build qua `server/scripts/build-sea.mjs` (`npm run build:sea`
   trong `server/`), xem "Ghi chú kỹ thuật SEA" bên dưới về 2 lỗi thật đã gặp + cách fix.
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
│       ├── main.rs         # entry, đăng ký plugin (shell/dialog/autostart), chọn spawn_dev/spawn_release
│       │                   #   theo cfg!(debug_assertions), graceful shutdown khi đóng cửa sổ
│       ├── sidecar.rs       # spawn_dev() — spawn `node server/src/bootstrap.ts` (cargo tauri dev).
│       │                   #   spawn_release() — .sidecar("k8sql-server") (binary SEA, cargo tauri build);
│       │                   #   tự resolve resource dir "public" qua Tauri path API rồi truyền --public-dir
│       │                   #   cho sidecar (KHÔNG để Node tự đoán qua process.execPath — xem "Ghi chú SEA")
│       └── ports.rs         # find_available_port(), mặc định DEFAULT_PORT=4210
│   └── binaries/            # SEA binary theo target-triple (vd k8sql-server-x86_64-unknown-linux-gnu),
│                             #   nạp qua tauri.conf.json's bundle.externalBin
│
├── server/
│   ├── package.json         # engines: node >=22
│   ├── tsconfig.json        # allowJs: true, checkJs: false
│   ├── legacy/               # PORT từ k8sctl — controllers/, services/, utils/, scripts/lib/, app.js
│   │                         #   (export createApp({publicDir}) thay vì app đã cấu hình sẵn — xem "Ghi chú SEA")
│   ├── src/bootstrap.ts      # entry mới: đọc --port/--host/--public-dir, gọi createApp(), app.listen(),
│   │                         #   log "K8SQL_READY port=<n>"
│   ├── scripts/build-sea.mjs # esbuild bundle + node --experimental-sea-config + postject → server/build/k8sql-server
│   ├── scripts/shims/optional-require.cjs  # shim SEA-safe thay `optional-require` (mongodb-legacy-driver dùng) — xem "Ghi chú SEA"
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
  - `tauri.conf.json` lúc đó tạm bỏ `bundle.externalBin` — đã thêm lại ở Phase 2.
- [x] **Phase 2** — Đóng gói Node SEA HOÀN TẤT cho Linux, `spawn_release()` dùng
  `.sidecar("k8sql-server")`. Build `.deb` cuối cùng (51MB) đã extract + chạy thử ĐÚNG layout thật
  (`usr/bin/k8sql-server` + `--public-dir usr/lib/k8sql/public` giả lập cách Tauri gọi) — `/health`,
  `/`, 404 handler đều đúng, không cần Node hệ thống trên máy đích nữa. 2 lỗi thật đã gặp + fix, xem
  chi tiết root cause trong comment đầu `server/scripts/shims/optional-require.cjs`:
  1. `mongodb-legacy-driver` (mongodb@3.7 pin, xem k8sctl/CLAUDE.md mục Mongo) dùng package
     `optional-require` — package này cố tình `eval("require")` để né bundler tĩnh, nhưng SEA chặn
     MỌI require() (kể cả eval'd) của module không phải built-in, ném `ERR_UNKNOWN_BUILTIN_MODULE`
     thay vì `MODULE_NOT_FOUND` mà `optional-require` biết bắt → crash sidecar ngay lúc khởi động
     dù không dùng driver legacy (vì `retrieveEJSON()` chạy eager ở module top-level). Fix: esbuild
     `alias` map `optional-require` → shim tĩnh riêng (`scripts/shims/optional-require.cjs`).
  2. Thử fix "đúng" bằng cách cài `mongodb-extjson` (dep upstream khuyến nghị) — phát hiện package
     bản mới nhất publish (3.0.3) TỰ NÓ bị lỗi trên MỌI Node hiện đại (không liên quan SEA, đã tự
     verify bằng `node -e "require('mongodb-extjson')"` trên Node 24 thuần, crash y hệt): bug thật
     trong `bson@3.0.2` nó kéo theo, `objectid.js` viết `require('os').hostname` thiếu `()`, truyền
     thẳng function reference vào `Buffer.from()`. Kết luận: package không dùng được, đã
     `npm uninstall`, shim trả `undefined` cho cả `mongodb-extjson` lẫn `kerberos` (2 module
     `mongodb-legacy-driver` có thể xin) — code gốc tự viết `legacySerialize()` riêng, không bao
     giờ thật sự gọi tới EJSON của driver legacy nên an toàn.
  3. **Bug layout thật đã gặp + fix**: giả định ban đầu "public/ nằm cạnh binary sidecar
     (`path.dirname(process.execPath)`)" SAI trên `.deb` — Tauri đặt `externalBin` ở
     `/usr/bin/k8sql-server` nhưng resource `public` (khai qua `bundle.resources`) lại ở
     `/usr/lib/k8sql/public/`, 2 thư mục không liên quan theo đường dẫn tương đối (layout khác nhau
     tuỳ loại bundle .deb/.AppImage/.msi/.dmg). Fix đúng: `sidecar.rs::spawn_release()` tự resolve
     qua `app.path().resolve("public", BaseDirectory::Resource)` (API Tauri, đúng cho mọi loại
     bundle) rồi truyền qua CLI arg `--public-dir` cho sidecar — `bootstrap.ts` chỉ đọc arg này,
     KHÔNG tự đoán vị trí nữa. `legacy/app.js` đổi từ `module.exports = app` (tự tính qua
     `__dirname`, vô nghĩa sau khi bundle SEA) sang `module.exports = { createApp({publicDir}) }`.
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
