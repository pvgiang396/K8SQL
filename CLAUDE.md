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
   keychain (crate `keyring` phía Rust, qua `native_bridge.rs`) cho giá trị secret thật — **đã
   triển khai** (Phase 3 phần lõi, xem trạng thái phase bên dưới).
5. **Port mặc định 4210** (k8sctl dùng 3210) — 2 app chạy song song không xung đột. Dò port trống
   nếu bị chiếm (`src-tauri/src/ports.rs`).
6. **Ngôn ngữ Hybrid**: `server/legacy/**/*.js` giữ nguyên JS; mọi code MỚI (`server/src/**/*.ts`,
   toàn bộ `src-tauri/`) viết TypeScript/Rust. `server/tsconfig.json` có `allowJs: true`.
7. **Ràng buộc cứng — tương thích REST API**: mọi route trong `server/legacy/app.js` phải giữ
   nguyên path/method/request/response so với `k8sctl/app.js` gốc, để `r3workspace/index.js` chỉ
   cần đổi `K8SCTL_URL` → `K8SQL_URL` là chạy được. Route MỚI đã thêm (không có ở k8sctl gốc):
   `POST /internal/shutdown` (graceful shutdown), `POST /internal/import-k8sctl-config` (import 1
   lần từ export cũ), `GET/POST /native/autostart` (proxy sang `native_bridge.rs`).

## Cấu trúc repo

```
k8sql/
├── src-tauri/              # Rust shell
│   ├── Cargo.toml, tauri.conf.json, build.rs, capabilities/default.json
│   └── src/
│       ├── main.rs           # entry, đăng ký plugin (shell/dialog/autostart), start native_bridge,
│       │                     #   chọn spawn_dev/spawn_release theo cfg!(debug_assertions), graceful
│       │                     #   shutdown khi đóng cửa sổ, resolve_data_dir() (app-data OS chuẩn)
│       ├── sidecar.rs         # spawn_dev()/spawn_release() — truyền --data-dir + --native-bridge-url/
│       │                     #   -token cho sidecar ngoài --port/--public-dir cũ
│       ├── native_bridge.rs   # HTTP loopback (axum) — /secret/:ref (keychain, crate `keyring`) +
│       │                     #   /autostart (tauri-plugin-autostart) — bearer token/session
│       └── ports.rs           # find_available_port(), mặc định DEFAULT_PORT=4210
│   └── binaries/            # SEA binary theo target-triple, nạp qua tauri.conf.json's bundle.externalBin
│
├── server/
│   ├── package.json         # engines: node >=22
│   ├── tsconfig.json        # allowJs, moduleDetection: force (xem "Ghi chú kỹ thuật TS")
│   ├── legacy/                 # PORT từ k8sctl — controllers/, services/, utils/, app.js
│   │   │                       #   (export createApp({publicDir, registerExtraRoutes}))
│   │   └── utils/base-dir.js   # MỚI — getBaseDir() đọc process.env.K8SQL_BASE_DIR, thay __dirname
│   │                           #   (bug thật: __dirname trong SEA = dirname(execPath), không phải
│   │                           #   thư mục source — sửa ở 7 file legacy, xem "Ghi chú kỹ thuật SEA")
│   ├── src/
│   │   ├── bootstrap.ts             # entry: đọc --port/--host/--public-dir/--data-dir/--native-bridge-*,
│   │   │                           #   set K8SQL_BASE_DIR, getDb()+materializeLegacyConfig() TRƯỚC
│   │   │                           #   require legacy/app, đăng ký route /internal/*, /native/autostart
│   │   ├── config/db.ts             # SQLite (node:sqlite) — rancher_clusters, db_environments,
│   │   │                           #   namespace_groups, app_settings (schema DDL trong chính file)
│   │   ├── secrets/keychainClient.ts # gọi native_bridge (getSecret/setSecret/deleteSecret/get|setAutostart)
│   │   ├── secrets/envShim.ts        # materializeLegacyConfig() — SQLite+keychain → config/*.json + .env
│   │   │                           #   thật trên đĩa (chạy lại sau mỗi lần SQLite đổi, vd sau import)
│   │   └── migration/importFromK8sctl.ts  # import export cũ k8sctl (GET /sql/config/export) vào SQLite+keychain
│   ├── scripts/build-sea.mjs              # esbuild bundle + node --experimental-sea-config + postject
│   ├── scripts/shims/optional-require.cjs # shim SEA-safe thay `optional-require` (mongodb-legacy-driver)
│   ├── scripts/import-k8sctl-config.mjs   # CLI mỏng POST file export cũ tới sidecar đang chạy
│   └── public/                # REUSE: index.html, vendor/*, shared/settings-modal.* (đã sửa — bỏ ô
│                               #   "Thư mục cài đặt", thêm toggle "Khởi động cùng hệ thống")
│
└── README.md                 # hướng dẫn chạy dev
```

## Trạng thái triển khai theo phase

- [x] **Phase 1** — Node backend port xong, chạy độc lập verify OK qua curl (`/health`, static
  `public/`, 404 handler, `/settings/current` đều đúng như k8sctl gốc khi chưa có config thật;
  `/sql/environments` trả lỗi rõ ràng — đúng kỳ vọng vì chưa có config, không phải bug). Tauri shell
  (`main.rs`/`sidecar.rs`/`ports.rs`/`tauri.conf.json`) **compile sạch** (`cargo check`/`cargo
  build`, 0 warning). **Đã verify GUI thật trên máy user (có desktop)** — cửa sổ mở đúng, hiển thị
  đúng SQL Tool UI như k8sctl. Bug thật gặp lúc verify (đã fix, xem commit riêng): `tauri.conf.json`
  khai sẵn 1 window mặc định (label ngầm định `"main"`) TRÙNG với window `main.rs` tự tạo sau khi
  sidecar sẵn sàng → panic `WebviewLabelAlreadyExists("main")` ngay khi mở app — fix: `"windows":
  []` trong config, để `main.rs` là nơi duy nhất tạo cửa sổ.
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
- [x] **Phase 3 (phần lõi) — SQLite + keychain + import + autostart, HOÀN TẤT và verify E2E** (qua
  fake bridge Node giả lập native_bridge.rs, vì máy dev không chạy được GUI thật để test Rust
  keychain trực tiếp — user cần tự xác nhận keychain thật hoạt động trên máy có desktop, xem "Việc
  cần user tự làm" bên dưới):
  - `native_bridge.rs` (axum + `keyring` crate) — `/secret/:ref` (GET/PUT/DELETE), `/autostart`
    (GET/POST qua `tauri-plugin-autostart`), bearer token random/session truyền cho sidecar qua CLI
    arg lúc spawn.
  - **Bug thật đã gặp + fix — `__dirname` trong SEA không chỉ ảnh hưởng `public/`**: 7 file legacy
    khác (`db-config.service.js`, `db-environment.service.js`, `kube.service.js`,
    `provision.service.js`, `rancher.client.js`, `settings.service.js`, `utils/logger.js`) tính
    đường dẫn `config/*.json`/`.env`/`logs/` qua `path.join(__dirname, "..", ...)` — đã tự verify
    thực nghiệm `__dirname` trong bundle SEA luôn bằng `path.dirname(process.execPath)` (dựng 1 SEA
    binary test riêng, di chuyển sang thư mục khác, in `__dirname` ra) → trên layout `.deb` thật
    (`/usr/bin/k8sql-server`) sẽ trỏ vào `/` (filesystem root, không ghi được). Fix: thêm
    `legacy/utils/base-dir.js` (`getBaseDir()` đọc `process.env.K8SQL_BASE_DIR`, bootstrap.ts set
    trước khi require bất kỳ legacy service nào), sửa cả 7 chỗ dùng `__dirname` → `getBaseDir()`.
  - `envShim.materializeLegacyConfig()` ghi `config/rancher-clusters.json`/`db-environments.json`/
    `namespaces.json`/`.env` từ SQLite+keychain vào `K8SQL_BASE_DIR` — chạy lúc sidecar khởi động
    VÀ sau mỗi lần SQLite đổi (vd sau import) để legacy code (đọc file tĩnh) thấy dữ liệu mới ngay,
    không cần restart (bug thật đã bắt: quên gọi lại lần 2, `/sql/environments` trả rỗng sau import
    cho tới khi restart — đã fix, gọi lại `materializeLegacyConfig()` cuối route import).
  - `server/src/migration/importFromK8sctl.ts` + `scripts/import-k8sctl-config.mjs` — import export
    cũ k8sctl (`GET /sql/config/export`) vào SQLite+keychain, tự tạo Rancher cluster **placeholder**
    (rancher_url/cluster_id rỗng) nếu `rancherKey` chưa có sẵn, tự dịch `connectionString` →
    template `__HOST__` cho entry `mode: "k8s-tunnel"`. Chạy qua route `POST
    /internal/import-k8sctl-config` TRONG tiến trình sidecar đang sống (không phải script đứng
    riêng) — chỉ sidecar mới có sẵn bearer token gọi native_bridge lúc đó.
  - Settings modal: bỏ ô "Thư mục cài đặt" + nút "Chọn thư mục..." (Tauri không hỗ trợ relocate),
    thêm toggle "Khởi động cùng hệ thống" (`GET/POST /native/autostart`, route Node mới proxy sang
    `native_bridge.rs`).
  - **Settings write-path — ĐÃ FIX** (cùng phiên, ngay sau khi phát hiện): `POST
    /settings/rancher-clusters`/`/settings/db-environments`/`/settings/apply` giờ ghi thẳng SQLite +
    keychain qua `server/src/config/repository/settingsRepo.ts`
    (`upsertRancherClusters`/`upsertDbEnvironments`/`applySecretValues`), rồi gọi lại
    `materializeLegacyConfig()` ngay — không còn ghi trực tiếp `config/*.json` như trước (bug đã
    verify: lưu → restart sidecar → dữ liệu vẫn còn, xem test trong lịch sử commit). `applySettings`
    bỏ hẳn cơ chế "installDir + spawn script bash/PowerShell" của k8sctl gốc (không áp dụng —
    Tauri không relocate) — chỉ còn ghi `values` (secret) vào keychain theo đúng tên biến derive từ
    `rancher_clusters.name`/`db_environments.name` (`deriveTokenEnvVar`/`deriveConnStringEnvVar`,
    `envShim.ts`).
- [ ] **Phase 4** — First-run wizard với progress bar % (`window.emit("wizard-progress", ...)`) —
  phần lớn hạ tầng (SQLite/keychain/import) đã có sẵn từ Phase 3, chỉ còn thiếu UI wizard bọc ngoài.
- [ ] **Phase 5** — `tauri-plugin-dialog` thay hẳn `scripts/lib/browse-directory.js`/`config-info.js`
  (xoá khỏi `legacy/scripts/lib/` — vẫn còn tồn tại, `settings.service.js` vẫn require, chưa xoá).
  `tauri-plugin-autostart` **đã dùng xong ở Phase 3** (không cần làm lại). Xoá mọi script cài đặt
  bash/PowerShell cũ (không port sang k8sql, xem "Việc KHÔNG port" bên dưới — hiện chưa từng copy
  sang nên thực ra không có gì phải xoá, chỉ cần xác nhận không ai lỡ thêm lại).
- [x] **Phase 6 (một phần) — lệnh build đa nền tảng local, chưa phải CI thật**:
  `scripts/build-cross-platform.mjs` (root `k8sql/`, không phải `server/scripts/` — orchestrator
  gọi cả `server/` lẫn `src-tauri/`) — 1 lệnh tự nhận diện OS hiện tại, build native cho đúng OS đó
  (`scripts/lib/build-native.mjs`, gom lại luồng thủ công cũ) + thử cross-build Windows từ Linux
  (`scripts/lib/build-windows-cross.mjs` + `docker/windows-cross.Dockerfile`).
  - **Sửa 1 hiểu nhầm trước đó**: tưởng "SEA bắt buộc build từ đúng binary Node của OS/arch đích,
    không cross-compile được" — SAI 1 phần. Đã tự verify: bước SEA build được TỪ LINUX cho Windows
    **không cần Docker** — chỉ cần tải `node.exe` bản Windows thật (nodejs.org, không cần chạy),
    `postject` (module WASM portable, tự đọc dist/api.js xác nhận: tự nhận diện định dạng
    PE/ELF/Mach-O từ magic bytes CỦA CHÍNH FILE, không dựa `process.platform`) tiêm blob vào file đó
    ngay trên Linux — output là file PE32+ hợp lệ thật (verify bằng `file` command +tự check magic
    bytes trong code). Phần THẬT SỰ không cross-compile được chỉ là vỏ Tauri/Rust (GUI cần link
    `webkit2gtk`/`WebView2`/`WKWebView` đúng OS) + trình đóng gói cài đặt.
  - **Windows** (Rust/Tauri qua Docker, target `x86_64-pc-windows-gnu` MinGW): **ĐÃ VERIFY THÀNH
    CÔNG THẬT** — `node scripts/build-cross-platform.mjs` (mặc định trên Linux) chạy trọn 1 lệnh ra
    cả `dist/linux-x64/k8sql_0.1.0_amd64.deb` lẫn `dist/windows-x64/k8sql_0.1.0_x64-setup.exe`, xác
    nhận bằng `file` (`PE32 executable ... Nullsoft Installer self-extracting archive`) + ownership
    đúng user thường (không phải root). Rủi ro WebView2/COM binding lo trước đó **KHÔNG xảy ra** —
    `webview2-com` compile sạch qua GNU target. Vẫn giữ nguyên cảnh báo **KHÔNG CHÍNH THỨC** (Tauri
    khuyến nghị build native Windows thật/CI runner Windows dùng MSVC, không phải GNU) vì chưa verify
    được app Windows thật sự MỞ ĐÚNG trên máy Windows thật (máy dev không có Windows để tự chạy thử).
    2 bug thật đã gặp + fix khi làm bước này (đã sửa vào code, không chỉ note lại):
    1. Docker named volume (`k8sql-windows-cross-target`) dùng cache `target/` KHÔNG đọc trực tiếp
       được từ host — script cũ tìm sai chỗ dù build container đã "Finished 1 bundle" thành công. Fix:
       để chính container `cp` kết quả vào `/work/dist/windows-x64` (bind-mount thật) trước khi thoát.
    2. Container mặc định chạy root → ghi file `root:root` vào `dist/` bind-mount, cần sudo mới xoá
       được (vi phạm nguyên tắc tránh sudo của workspace). Fix: thêm `--user uid:gid` (từ
       `os.userInfo()`) + `-e HOME=/tmp`. Hệ quả kéo theo: named volume MỚI kế thừa ownership root từ
       thư mục gốc trong image (`/usr/local/cargo` trong `rust:1-bookworm` thuộc root) → lần build đầu
       sau khi đổi `--user` luôn lỗi `Permission denied`. Fix: `buildWindowsRustViaDocker()` tự chạy 1
       container tạm (`alpine chown -R uid:gid`) trên cả 2 volume cache TRƯỚC mỗi lần build (idempotent,
       không hại gì nếu ownership đã đúng) — không bắt user tự chạy lệnh chown thủ công nữa.
  - **macOS**: **KHÔNG có cách nào cross-build qua Docker** — Apple cấm chạy Xcode/SDK macOS trên
    phần cứng không phải Apple (giới hạn pháp lý+kỹ thuật của Apple, không phải thiếu cấu hình).
    `scripts/build-cross-platform.mjs` cố ý KHÔNG đưa `darwin` vào target mặc định khi chạy trên
    Linux, chỉ in cảnh báo rõ ràng nếu bị gọi tường minh (`--targets macos`) — không giả vờ build.
  - **CHƯA làm**: `.gitlab-ci.yml` thật (CI 3 runner GitLab) — script này chỉ chạy LOCAL trên máy
    dev, chưa tích hợp CI. `apple-native`/`windows-native` (keyring, xem bug đã fix ở dưới) vẫn CHƯA
    verify trên máy Windows/macOS thật — chỉ compile-check được.
- [ ] **Phase 7** — Smoke-test tương thích API, cập nhật `r3workspace/CLAUDE.md` biết `K8SQL_URL`
  (đã thêm ghi chú tham khảo sơ bộ, chưa đổi mặc định — xem `r3workspace/CLAUDE.md`).

## Bug thật nghiêm trọng đã gặp + fix: `keyring` crate thiếu feature → secret KHÔNG persist

Sau khi user cài `.deb` thật + import config cũ, `reveal-value` trả rỗng dù import báo "thành công"
(`hasValue: false` cho mọi entry). Root cause: `Cargo.toml` khai `keyring = "3"` **không kèm feature
nào** — crate biên dịch được, `PUT /secret/:ref` trả `204` (trông như thành công), nhưng KHÔNG thật
sự ghi vào D-Bus Secret Service — chỉ 1 `Entry` object ĐANG SỐNG mới đọc lại được giá trị vừa ghi
(kiểu lưu tạm trong bộ nhớ chính object đó), 1 `Entry` MỚI (kể cả cùng service+ref, cùng tiến trình)
luôn trả `NoEntry`. Tự viết 1 binary Rust test riêng (`keyring::Entry::new()` set rồi get bằng 2
object khác nhau) để xác nhận + tìm feature đúng trước khi sửa thật, không đoán mò.

**Fix**: `keyring = { version = "3", features = ["sync-secret-service", "tokio", "crypto-rust",
"apple-native", "windows-native"] }` (Linux cần `sync-secret-service` + runtime (`tokio`) +
crypto (`crypto-rust`) tường minh — thiếu runtime sẽ lỗi compile ngay, dễ phát hiện; thiếu
`crypto-rust`/`openssl` cũng lỗi compile; nhưng thiếu CẢ CỤM feature này như ban đầu thì compile
sạch, chỉ sai lặng lẽ ở runtime — đây là phần nguy hiểm nhất của bug này). `apple-native`/`windows-native` cho macOS/Windows — **CHƯA
tự verify được trên 2 platform đó**, chỉ có máy Linux để test.

**Verify thật đã làm**: xoá 3 db_environments + 2 rancher_clusters cũ (secret rỗng, qua API
`POST /settings/*-clusters {clusters:[]}`/`{environments:[]}`, KHÔNG động file SQLite trực tiếp —
bị chính công cụ Claude Code tự chặn thao tác ghi trực tiếp vào DB, đúng ý phải đi qua API thật) →
import lại → `reveal-value` đúng giá trị thật → **user đóng hẳn app + mở lại** → `reveal-value` vẫn
đúng giá trị thật. Đây là bằng chứng persist qua OS keychain thật, không phải cache trong tiến trình.

## Việc cần user tự làm (không tự verify được trên máy dev)

- ~~**Keychain thật**~~ — ĐÃ VERIFY (xem mục bug ở trên) — đọc/ghi đúng OS keychain thật (GNOME
  Keyring trên Linux của user), sống sót qua restart app thật. **CHƯA verify trên macOS/Windows**
  (feature `apple-native`/`windows-native` mới chỉ compile-check được, chưa chạy thật).
- **Autostart thật**: bật toggle "Khởi động cùng hệ thống", đăng xuất/khởi động lại máy, xác nhận
  app tự mở — `tauri-plugin-autostart`'s cơ chế cụ thể theo desktop environment (systemd user
  unit/`.desktop` autostart/registry Run key) chưa tự verify được.
- **2 Rancher cluster placeholder** sau khi import (`K8SOPERATOR-TTN_VNPT_VN`,
  `PLATFORM_IDG_VNPT_VN`) — thiếu URL+token thật, tự điền qua Settings UI (giờ ghi bền vững qua
  restart, xem "Settings write-path — ĐÃ FIX" ở trên).

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
