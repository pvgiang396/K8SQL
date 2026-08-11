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
   `POST /ingresses/delete {domain, ingress}` (2026-08-10, xem `r3workspace/docs/team-notes.md`
   #91) — thêm ở CẢ 2 provider (`services/providers/{rancher,kubeconfig}/ingress.js`), đúng pattern
   `deleteDeployment`/`deleteService`/`deleteConfigMap` đã có sẵn (những hàm này port từ k8sctl,
   nhưng `deleteIngress` thì CHƯA có ở k8sctl gốc tại thời điểm thêm — nên tạm liệt vào nhóm "route
   mới" ở đây, cần backport ngược lại k8sctl khi có dịp). **Lưu ý quan trọng khi dùng trên bản đã
   đóng gói (`.deb`/binary SEA đang chạy)**: sửa `server/legacy/**/*.js` trong source KHÔNG có tác
   dụng ngay với app đang chạy — sidecar chạy từ `/usr/bin/k8sql-server` (binary đã bundle), không
   đọc trực tiếp từ thư mục source này. Cần rebuild (`npm run build:sea` + đóng gói lại Tauri) rồi
   cài lại mới nhận code mới; nếu chỉ cần xoá 1 Ingress gấp mà chưa kịp rebuild, gọi thẳng Rancher
   Norman API (`DELETE {rancherUrl}/v3/project/{clusterId}:{projectId}/ingresses/{namespace}:{name}`
   kèm `Authorization: Bearer <token>`) như đã làm ở #91.

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
  - **Nhóm namespace (`namespace_groups`) — ĐÃ FIX 2 lỗ hổng thật (2026-08-11, phát hiện khi AI dùng
    `--deploy` lần đầu cho 1 domain mới):**
    1. Bảng `namespace_groups` **thiếu cột `project_id`** (bắt buộc cho provider `rancher`,
       `kube.service.js::createRancherContext()` throw `Missing projectId` nếu thiếu) — dù có ghi đủ
       dữ liệu vào SQLite, `materializeLegacyConfig()` sinh ra `namespaces.json` vẫn KHÔNG dùng được.
       Fix: thêm cột `project_id TEXT` vào `CREATE TABLE` + migration idempotent (`PRAGMA
       table_info` kiểm tra trước, `ALTER TABLE ADD COLUMN` nếu thiếu, `server/src/config/db.ts`) cho
       DB cũ đã tồn tại; `materializeLegacyConfig()` (`envShim.ts`) đưa `projectId` vào output.
    2. **Chưa có route/UI nào ghi vào `namespace_groups`/`namespace_group_domains`** — chỉ có route
       kế thừa `POST /provision/add-group` (từ k8sctl gốc) ghi THẲNG file `config/namespaces.json`,
       hoàn toàn không qua SQLite → bị `materializeLegacyConfig()` ghi đè mất (về `[]`, vì bảng SQLite
       rỗng) ngay lần khởi động lại HOẶC ngay lần lưu bất kỳ cấu hình Settings nào khác (cả
       `saveRancherClusters`/`saveDbEnvironments`/`applySettings` đều tự gọi lại
       `materializeLegacyConfig()` sau khi ghi — xem "Settings write-path — ĐÃ FIX" ở trên). Đã tự
       verify bug này bằng thực nghiệm (thêm group qua `add-group`, restart app → mất; lưu lại
       Rancher cluster không đổi gì → cũng mất ngay, không cần đợi restart).
       Fix: thêm `settingsRepo.upsertNamespaceGroups()`/`listNamespaceGroups()` (cùng pattern
       replace-all theo `name` như `upsertRancherClusters`) + `GET/POST /settings/namespace-groups`
       (`settings.service.js`/`settings.controller.js`/`app.js`) ghi thật vào SQLite rồi
       `materializeLegacyConfig()` ngay — cùng công thức 2 bảng kia. Route `add-group` cũ VẪN giữ
       nguyên (tương thích API k8sctl gốc, dùng cho ai còn thao tác qua script cũ) nhưng AI/UI nên
       dùng route mới để mapping sống sót qua restart/materialize.
    3. **UI**: thêm section "Danh sách Nhóm Namespace (domain → deployment)" vào
       `public/shared/settings-modal.html`/`.js`/`.css` — mỗi nhóm 1 card: Tên nhóm, Rancher Cluster
       (`<select>` từ danh sách cluster ĐÃ lưu — không hỗ trợ cluster "isNew"/ad-hoc như bảng
       Connection String, vì token ad-hoc chỉ sống trong phiên UI, không đáng để nhóm namespace phụ
       thuộc), Project/Namespace (cascade qua `rancherProjects`/`rancherNamespaces`, tự viết
       `buildGroupCascadeCell()` riêng thay vì tái dùng `buildCascadeCell()` — hàm gốc hardcode gọi
       lại `renderDbEnvTable()` ở nhánh "chọn nhập tay", tái dùng trực tiếp sẽ vẽ nhầm bảng), Domain
       (list `{url, env}` động, `env="prod"` để `--deploy`/`--configmap` tự báo Telegram), Service →
       Deployment (list `{key, deployment}` động, `key` khớp tham số `<service>` của `node index.js
       --deploy`, gợi ý tên deployment qua `<datalist>` nạp từ `rancherServices` sau khi chọn xong
       Namespace — không ép chọn, vẫn gõ tay tự do). Chỉ hỗ trợ provider `rancher` qua UI (nhóm
       provider `kubeconfig`, nếu có, vẫn phải quản lý qua gọi API `/settings/namespace-groups` trực
       tiếp — chưa có ô upload file kubeconfig trong UI này).
    Đã verify qua Playwright thật (không chỉ đọc code): mở Settings modal, card hiển thị đúng dữ liệu
    đã migrate (`DVCCDDEMO_HUE` → `dvc-cd-hue`/`applications-vtu`/3 service `r3web`/`r3svc`/`r3auth`),
    thêm/xoá 1 nhóm test qua UI hoạt động đúng không phá dữ liệu thật, restart app + lưu lại Rancher
    cluster không đổi gì → mapping vẫn còn nguyên (2 kịch bản từng làm mất dữ liệu trước khi fix).
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
    khuyến nghị build native Windows thật/CI runner Windows dùng MSVC, không phải GNU).
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
    3. **Bug thật đã gặp + fix (2026-08-10)**: `docker/windows-cross.Dockerfile` thiếu
       `libayatana-appindicator3-dev` → `cargo tauri build` (dù target Windows) panic
       `Can't detect any appindicator library` ngay ở bước bundler — tauri-cli tự kiểm tra thư viện
       tray-icon trên HOST build (container Linux) bất kể target OS. Cùng bug/fix áp dụng cho build
       `.deb` Linux native (`node scripts/build-cross-platform.mjs --targets linux`) trên máy dev
       thật — thiếu gói `libayatana-appindicator3-dev` (chỉ có `.so` runtime, thiếu `.pc` cho
       pkg-config) gây lỗi tương tự. Fix: thêm dòng cài gói vào cả Dockerfile lẫn cài trực tiếp trên
       máy dev qua `apt-get install -y libayatana-appindicator3-dev`.
  - **ĐÃ VERIFY THẬT trên Windows 11 thật (2026-08-10, qua VM `win11-2` GNOME Boxes/libvirt)** — cài
    `.exe` NSIS thành công ("Installation Complete — Setup was completed successfully"), app mở
    đúng UI (Object Explorer, tiếng Việt hiển thị đúng). **Kết luận về dialog "Open File - Security
    Warning"/SmartScreen mà user report ban đầu (srs/nangcapk8sql/v1.md #4): ĐÂY LÀ HÀNH VI MẶC ĐỊNH
    của Windows cho MỌI file .exe tải qua trình duyệt chưa ký số** (gắn Zone.Identifier/"Mark of the
    Web") — không phải bug của installer. Xác nhận chéo: file tải qua `Invoke-WebRequest` (PowerShell,
    không gắn MOTW) chạy thẳng KHÔNG hiện cảnh báo nào, cùng 1 file `.exe`. Không mua/tự tạo
    code-signing cert (ngoài phạm vi, tốn phí) — chỉ cần hướng dẫn user "More info → Run anyway" nếu
    Windows hiện SmartScreen đầy đủ (máy test dùng dialog "Security Warning" đơn giản hơn, tuỳ
    Windows Defender config/policy từng máy).
  - **macOS**: **KHÔNG có cách nào cross-build qua Docker** — Apple cấm chạy Xcode/SDK macOS trên
    phần cứng không phải Apple (giới hạn pháp lý+kỹ thuật của Apple, không phải thiếu cấu hình).
    `scripts/build-cross-platform.mjs` cố ý KHÔNG đưa `darwin` vào target mặc định khi chạy trên
    Linux, chỉ in cảnh báo rõ ràng nếu bị gọi tường minh (`--targets macos`) — không giả vờ build.
  - **CHƯA làm**: `.gitlab-ci.yml` thật (CI 3 runner GitLab) — script này chỉ chạy LOCAL trên máy
    dev, chưa tích hợp CI. `apple-native`/`windows-native` (keyring, xem bug đã fix ở dưới) vẫn CHƯA
    verify trên máy Windows/macOS thật — chỉ compile-check được.
- [ ] **Phase 7** — Smoke-test tương thích API, cập nhật `r3workspace/CLAUDE.md` biết `K8SQL_URL`
  (đã thêm ghi chú tham khảo sơ bộ, chưa đổi mặc định — xem `r3workspace/CLAUDE.md`).
- [x] **Phase 8 — System tray + chế độ chạy nền, ĐÃ VERIFY THẬT trên Linux (không phải chỉ compile)**:
  `src-tauri/src/main.rs` — thêm `tauri::tray::TrayIconBuilder` (menu `Open`/`Exit`, dùng lại
  `app.default_window_icon()` — chưa có asset tray riêng) + `tauri-plugin-single-instance` (đăng ký
  ĐẦU TIÊN, bắt buộc theo yêu cầu plugin). Cần feature `tray-icon` trên crate `tauri` (Cargo.toml,
  trước đó `features = []` không đủ để dùng `tauri::tray::*`/`tauri::menu::*`).
  - Cờ `--tray` (đọc qua `std::env::args()`, không dùng `clap`): dựng cửa sổ nhưng không `.show()` —
    chỉ tray icon xuất hiện. `tauri_plugin_autostart::init(..., Some(vec!["--tray"]))` (trước đó
    `None`) — OS tự khởi động app lúc đăng nhập giờ luôn ở chế độ tray-only, không tự bật cửa sổ.
  - `on_window_event` `CloseRequested` đổi hẳn: trước đây shutdown sidecar + để cửa sổ đóng thật, giờ
    `api.prevent_close()` + `window.hide()` — sidecar/tray icon vẫn sống. Logic shutdown cũ chuyển
    nguyên vào `quit_app()`, chỉ gọi từ menu tray "Exit".
  - `tauri-plugin-single-instance`: instance thứ 2 khởi chạy chỉ gọi `show_main_window()` trên
    instance gốc (bỏ qua argv của instance thứ 2) — không spawn thêm sidecar. Cần thiết vì cả 2
    instance dùng chung 1 `app_data_dir()` (SQLite) — không có guard này sẽ tranh chấp file khi user
    bấm icon desktop trong lúc app đã chạy nền (do AI mở hoặc do autostart).
  - **Đã tự verify thật** (không chỉ đọc code, có bằng chứng cụ thể — xem lịch sử test trong phiên
    làm feature này): `cargo check` sạch; cửa sổ+tray cùng xuất hiện khi mở bình thường (`wmctrl -l`
    thấy cửa sổ, D-Bus `org.kde.StatusNotifierWatcher` thấy `tray_icon_tray_app_<pid>` đăng ký);
    đóng cửa sổ bằng đúng window ID → biến mất khỏi `wmctrl -l` nhưng sidecar (`curl /health`) + tiến
    trình vẫn sống; `k8sql --tray` → không cửa sổ nào trong `wmctrl -l` nhưng tray + sidecar có; bật
    toggle "Khởi động cùng hệ thống" → `~/.config/autostart/*.desktop` có `Exec=... --tray`; mở
    instance thứ 2 trong lúc instance `--tray` đang chạy → không có sidecar/process thứ 2
    (`ps aux` xác nhận), cửa sổ instance gốc tự hiện lên (chứng minh gián tiếp `show_main_window()`
    hoạt động đúng — dùng chung code path với tray menu "Open"/click tray icon).
  - **CHƯA tự click được qua UI thật** (menu tray "Open"/"Exit", click icon) — màn hình dev bị khoá
    (screensaver) giữa lúc test, không tự ý mở khoá phiên user. Tin tưởng dựa trên: `show_main_window()`
    đã verify gián tiếp qua single-instance test ở trên; `quit_app()` chỉ là logic shutdown CŨ (đã
    chạy đúng nhiều lần trước đây trong `CloseRequested`) di chuyển sang chỗ gọi khác + `app.exit(0)`
    (API chuẩn Tauri) — rủi ro thấp nhưng CHƯA click tay xác nhận 100%.
  - **CHƯA verify trên macOS/Windows** — hành vi click tray icon (mở menu vs "activate") phụ thuộc
    protocol tray riêng từng OS/DE, máy dev không có Mac/Windows thật. Icon tray dùng icon màu có
    sẵn, macOS quy ước cần icon "template" đơn sắc cho menu bar — chưa làm riêng.
  - **Lưu ý hành vi mới cho AI**: xem mục "AI dùng k8sql" bên dưới — không còn nhờ user mở app tay.
- [x] **Phase 9 (2026-08-10) — 3 fix từ `srs/nangcapk8sql/v1.md`, đã verify qua app cài thật (Linux
  `.deb` + Windows `.exe`)**:
  1. **Lệch đường phân cách**: `header .header-left` (`server/public/index.html`) trước đây hardcode
     `width: 270px`, không đồng bộ với `aside` (dùng `var(--aside-width, 270px)`, bị ghi đè khi kéo
     `#dividerH`) → viền phải header và viền phải aside lệch nhau sau khi resize. Fix: đổi
     `header-left` dùng chung `var(--aside-width, 270px)`.
     - **Bug thứ 2 phát hiện thêm ngay sau đó (cùng khu vực resize, user báo tiếp)**: kéo `#dividerV`
       (chia `#editor`/`#resultsWrap`) xuống bị "kẹt" ở chiều cao rất nhỏ, không kéo to ra được nữa.
       Root cause: `setupDivider(dividerV, {..., max: Math.round(window.innerHeight * 0.7)})` —
       `max` tính **1 LẦN DUY NHẤT lúc script load trang**, không cập nhật lại khi cửa sổ
       resize/maximize sau đó → nếu cửa sổ lúc load nhỏ hơn lúc user thao tác thực tế, giá trị `max`
       cũ (nhỏ) kẹp cứng mọi lần kéo sau, dù CSS `#editor { max-height: 70vh }` đã tự responsive
       đúng. Đã tự verify bằng Playwright (`mcp__playwright__browser_run_code_unsafe` giả lập kéo
       chuột): resize viewport 513→800px cao rồi kéo divider xuống 300px chỉ tăng được tới đúng
       359px (= round(513*0.7), giá trị `max` cũ) thay vì phải lên tới ~560px. Fix:
       `setupDivider()` nhận `max` là function, gọi lại **mỗi lần bắt đầu kéo** (`mousedown`) thay vì
       tính 1 lần — `setupDivider(dividerV, {..., max: () => Math.round(window.innerHeight * 0.7)})`.
       Verify lại bằng đúng kịch bản Playwright trên: sau fix, kéo tới đúng 560px (= round(800*0.7)).
     - **Bug thứ 3 phát hiện thêm (2026-08-10, user gửi ảnh `srs/nangcapk8sql/LoiDuongLine2.png`) —
       QUAN TRỌNG: KHÔNG tái hiện được bằng Playwright/Chromium, chỉ thấy khi chụp đúng app thật
       (WebKitGTK)**: (a) đường ngang `#dividerV` không chạm đường dọc `#dividerH` — hở 1 khoảng nhỏ
       ngay chỗ giao nhau; (b) đường ngang ngay dưới thanh công cụ (giữa `header` và `#tabBar`) bị
       "đúp" — 2 đường sát nhau thay vì 1. Root cause CHUNG: cả 2 đường phân cách "tĩnh" (không phải
       thanh kéo-resize) trước đây được vẽ bằng `border-right`/`border-bottom` của element LÂN CẬN
       (`aside{border-right}`, `#editor{border-bottom}`, `#tabBar{border-bottom}` cạnh
       `header{border-bottom}`) thay vì tự thanh divider vẽ — trên WebKitGTK (app thật) các border
       này không luôn render khớp pixel 1:1 ở ranh giới giữa 2 element khác nhau (khác Chromium lúc
       test bằng Playwright, nơi luôn khớp) → hở/đúp tuỳ layout cụ thể. **Bài học: bug loại này BẮT
       BUỘC verify bằng screenshot đúng app thật đã cài (`.deb`/`.exe`), Playwright/trình duyệt
       thường KHÔNG đủ để phát hiện hay xác nhận đã fix** — xem thêm mục cách chụp app thật ở dưới.
       Fix: xoá hẳn `aside{border-right}`, `#editor{border-bottom}`, `#tabBar{border-bottom}` — để
       CHÍNH `.divider-h`/`.divider-v` tự vẽ đường line tĩnh của mình qua `::after` (1px, màu
       `var(--border)`) thay vì dựa vào border của 2 element khác nhau ghép lại. `#tabBar`/editor vẫn
       phân biệt được với `header`/nhau nhờ khác màu nền (`--bg-alt` vs `--bg`), không cần border
       riêng.
     - **Bug thứ 4 — chính lần sửa bug thứ 3 lại gây lệch MỚI (user báo tiếp qua ảnh chụp)**: đặt
       `::after` của `.divider-v` (đường dọc, #dividerH) ở `left:2px` (gần giữa vùng kéo 5px) — sai vì
       KHÔNG khớp với 2 mốc toạ độ khác vẫn cố định: `header .header-left`'s `border-right` (nằm ở
       MÉP TRÁI #dividerH, x = --aside-width) và điểm bắt đầu đường ngang `.divider-h::after` của
       #dividerV (nằm ở MÉP PHẢI #dividerH, x = --aside-width + 5px, vì #dividerV nested trong
       query-panel bắt đầu ngay sau #dividerH). 3 điểm neo này vốn không cùng 1 toạ độ x, đặt line ở
       giữa (left:2px) làm nó KHÔNG khớp với CẢ HAI. Fix đúng: (a) đổi `.divider-v::after` sang
       `right:0` (khớp mép phải #dividerH = điểm bắt đầu #dividerV), (b) đổi
       `header .header-left { width: calc(var(--aside-width, 270px) + 5px) }` (cộng thêm đúng 5px =
       width #dividerH, để border-right của nó dịch sang khớp CÙNG toạ độ x = --aside-width + 5px) —
       cả 3 mốc giờ neo về đúng 1 toạ độ duy nhất. Verify bằng screenshot thật (crop+zoom pixel qua
       `python3 -c "from PIL import Image; ..."`) tại cả 2 điểm giao (header/aside VÀ
       #dividerH/#dividerV) — thẳng hàng hoàn toàn.
     - **Bug thứ 5 — phát hiện ngay sau đó (user báo tiếp)**: vùng `#dividerH` (5px) có nền
       `transparent` mặc định → lộ nền trắng (`--bg`) của `main`/trang thay vì xám như `aside` liền
       kề, dù đường line (::after) vẫn đúng vị trí. Fix: đổi `.divider-v { background: transparent }`
       → `background: var(--bg-alt)` (khớp màu nền `aside`) — chỉ `.divider-v` (dọc, giữa aside/query-
       panel, 2 màu nền khác nhau) cần fix này; `.divider-h` (ngang, giữa editor/resultsWrap, cùng nền
       trắng) không bị ảnh hưởng nên giữ nguyên `transparent`. Verify bằng lấy mẫu màu pixel
       (`im.getpixel((x,y))`) xác nhận vùng #dividerH cùng RGB `(245,246,248)` với aside, không còn
       dải trắng xen giữa.
     - **Sự cố thao tác gặp phải khi verify các bug trên (ghi lại để tránh lặp)**: sau khi
       `pkill -9` xong rồi launch lại NGAY LẬP TỨC bằng `DISPLAY=:0 nohup k8sql &`, có 1 lần cửa sổ
       mở lên nhưng sidecar KHÔNG bind port 4210 (curl connection refused, `ps aux` không thấy tiến
       trình `k8sql-server`) dù cửa sổ vẫn hiện UI (WebView giữ DOM cũ trong bộ nhớ từ phiên trước,
       trông như bình thường nhưng KHÔNG phải code mới) — nghi do single-instance/port chưa kịp giải
       phóng ngay sau kill -9 hàng loạt. Fix tạm: kill lại toàn bộ 1 lần nữa, đợi vài giây rồi mới
       launch — luôn xác nhận CẢ 2 điều kiện trước khi tin tưởng screenshot: (1) `curl
       127.0.0.1:4210/health` trả `200`, (2) `readlink -f /proc/<pid của k8sql-server>/exe` KHÔNG có
       hậu tố `(deleted)`.
  2. **Import/Export cấu hình đổi JSON → sqlite**: thêm
     `server/legacy/services/sql-config-codec.js` (`encodeToSqliteBuffer`/`decodeFromSqliteBuffer`,
     dùng `node:sqlite` — bảng `db_environments(name, data)`, cột `data` là JSON-encode nguyên vẹn
     từng entry kể cả `connectionString` thật). `GET /sql/config/export` trả file `.sqlite` nhị phân
     (`Content-Type: application/octet-stream`), `POST /sql/config/import` nhận qua
     `express.raw({type: "application/octet-stream"})` (route-scoped, không đụng `express.json()`
     global). Frontend đổi `fetchJson` → `fetch().arrayBuffer()`, file picker/input đổi sang
     `.sqlite`. `importConfig()`/`db-environment.service.js` giữ nguyên 100% — chỉ đổi lớp
     encode/decode ở biên. Đã verify round-trip qua `curl` + `node -e` (encode/decode) trên cả dev
     server lẫn `.deb` đã cài.
  3. **Cluster id lạ ("c-m-c4ghx99c") hiển thị thay tên cluster**: `rancher.client.js` hàm
     `listClustersAdhoc()` — Norman API `/v3/clusters` trả `name` rỗng cho cluster
     imported/provisioning, code cũ fallback thẳng `c.name || c.id` khiến combobox "Cluster ID"
     (Settings modal) hiện ID kỹ thuật như tên. Fix: `c.name || c.nameDisplay || `(chưa đặt tên ·
     ${c.id})`` — ưu tiên field hiển thị Norman chuẩn trước khi rơi về id có gắn nhãn rõ ràng. Chưa
     verify được với Rancher thật (máy dev không có `rancher_clusters` cấu hình sẵn) — cần user tự
     xác nhận combobox không còn hiện ID trần khi thêm lại cluster đang gặp lỗi.
  - **Bug môi trường phát hiện thêm lúc build lại `.deb`/`.exe` để áp fix trên**: thiếu
    `libayatana-appindicator3-dev` (Linux máy dev VÀ Docker image cross-build Windows) — xem chi
    tiết + fix trong mục Windows ở Phase 6 phía trên.
- [x] **3 fix UI nhỏ (2026-08-11), đã rebuild `.deb` + verify code chạy đúng qua process đang sống
  (chưa tự chụp màn hình xác nhận pixel, xem ghi chú Phase 9 bug thứ 3 — nhờ user tự nhìn app thật)**:
  1. Settings modal (`server/public/shared/settings-modal.js::renderDbEnvTable()`) — ẩn 4 field
     Project/Namespace/DB Host-Port/Pod có sẵn khi Rancher của 1 Connection String card = "Không
     dùng" (`env.rancherKey` falsy), qua `updateFieldVisibility()` toggle `style.display` trên các
     `.sm-field` tương ứng.
  2. `server/public/index.html` — đường ngang dưới ô tìm kiếm (`aside .filter-row`) đổi từ
     `border-bottom` sang `::after` riêng kéo dài thêm 5px (`right: -5px`), cùng nguyên lý +5px đã
     dùng cho `header .header-left` (Phase 9 bug thứ 4) — trước đó hở đúng 5px so với đường dọc
     `.divider-v::after` (#dividerH).
  3. `settings-modal.js::deleteClusterBtn` — cluster Rancher chưa gõ URL có `cluster.name` (Rancher
     Key tự sinh từ URL) rỗng, khiến nút "Xóa ngay" trong `confirmDeleteWithKey` không cách nào gõ
     khớp chuỗi rỗng để bật lên → không xoá được. Fix: bỏ qua bước gõ xác nhận Key khi
     `!cluster.name`, xoá thẳng.

## AI dùng k8sql

Kiểm tra `curl -s -m 2 http://127.0.0.1:4210/health`. Nếu không phản hồi:
1. Tự set `DISPLAY=:0` (đã verify hoạt động dù chạy qua Bash tool không kế thừa sẵn biến này — cùng
   máy/user với phiên desktop, chỉ thiếu env var) rồi tự chạy `k8sql --tray &` (chế độ nền, không bật
   cửa sổ, xem Phase 8) — không hỏi user mở tay.
2. Đợi vài giây rồi `curl` lại `/health`.
3. Chỉ nhắc user can thiệp tay nếu bước 1 cũng thất bại thật sự (vd không tìm thấy binary `k8sql`
   trong PATH, hoặc không có `/tmp/.X11-unix/X0`/phiên desktop nào đang mở — máy chưa đăng nhập).

**Bug thật đã gặp — rebuild+reinstall `.deb` KHÔNG tự áp dụng cho tiến trình đang chạy** (2026-08-10,
user report "vẫn còn lỗi" dù đã fix code + rebuild + `dpkg -i` xong): `dpkg -i` thay file
`/usr/bin/k8sql-server` trên đĩa, nhưng tiến trình ĐANG CHẠY vẫn giữ inode binary CŨ trong bộ nhớ
(`readlink /proc/<pid>/exe` báo `(deleted)`) — Linux không hot-swap executable của process đang sống.
Gọi lại `k8sql --tray &` SAU KHI rebuild **không mở tiến trình mới** — bị `tauri-plugin-single-instance`
(Phase 8) chặn, chỉ kích hoạt lại đúng tiến trình cũ (stale). **Bắt buộc `pkill -f k8sql-server` (hoặc
tắt hẳn qua tray menu "Exit") TRƯỚC khi `dpkg -i`/relaunch** để tiến trình mới thật sự nạp binary mới —
verify bằng `readlink -f /proc/<pid>/exe` phải trỏ đúng `/usr/bin/k8sql-server` (không có `(deleted)`).

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
