# k8sql

Desktop app (Windows/macOS/Linux) cho Kubernetes/Rancher Tool Server + SQL Tool — kế thừa backend
[k8sctl](https://gitlab.com/pvgiang396/k8sctl) qua Tauri (Rust) + Node.js sidecar, thay cho mô hình
"local server + trình duyệt kiosk-mode + service OS" hiện tại của k8sctl.

k8sctl tiếp tục chạy song song trong quá trình chuyển tiếp — xem chi tiết quyết định kiến trúc,
schema lưu trữ, và lộ trình từng phase trong [`CLAUDE.md`](CLAUDE.md).

## Trạng thái hiện tại

**Phase 1 + Phase 2 hoàn tất** (xem chi tiết + bài học thật trong `CLAUDE.md`):

- `server/legacy/` — toàn bộ controller/service/util port nguyên vẹn từ k8sctl (không sửa logic
  nghiệp vụ; `app.js` export `createApp({publicDir})` thay vì tự tính đường dẫn qua `__dirname`).
- `server/src/bootstrap.ts` — entry mới thay `app.listen()` cuối `app.js` gốc.
- `src-tauri/` — Rust shell: `cargo tauri dev` spawn thẳng `node` (đọc source TS trực tiếp);
  `cargo tauri build` spawn binary Node SEA đã đóng gói (`k8sql-server`) — không cần Node hệ thống
  trên máy đích.

## Chạy dev

```bash
# 1. Cài dependency Node
cd server && npm install

# 2. Chạy Tauri dev (spawn sidecar + mở cửa sổ trỏ vào http://127.0.0.1:4210)
cd ../src-tauri && cargo tauri dev
```

Yêu cầu hệ thống: Node.js ≥22, Rust stable ≥1.77 (qua `rustup`), `cargo-tauri` CLI
(`cargo install tauri-cli --locked`), và dependency hệ thống của Tauri cho từng OS (Linux:
`libwebkit2gtk-4.1-dev`, `libssl-dev`, `libgtk-3-dev`, `librsvg2-dev`, `patchelf`).

Kiểm tra nhanh chỉ phần Node (không cần Rust):

```bash
cd server && node src/bootstrap.ts --port 4210
curl http://127.0.0.1:4210/health
```

## Build bản cài đặt thật (release)

**Cách khuyến nghị — 1 lệnh duy nhất, tự nhận diện OS hiện tại:**

```bash
npm install                              # 1 lần, cài dependency cho script build (root package.json)
node scripts/build-cross-platform.mjs    # build native cho OS hiện tại + thử cross-build thêm nếu khả thi
```

- Chạy trên **Linux** → build `.deb` native cho Linux, **kèm thử cross-build Windows qua Docker**
  (`.exe` NSIS, xem "Cross-build Windows từ Linux" bên dưới — hướng KHÔNG CHÍNH THỨC, có thể lỗi).
- Chạy trên **macOS**/**Windows** → chỉ build native cho đúng OS đó (chưa hỗ trợ cross sang OS khác
  từ 2 OS này).
- **macOS luôn phải build TRÊN máy Mac thật** (hoặc CI runner macOS) — không có cách nào build được
  từ Linux/Docker, đây là giới hạn của Apple (không cho chạy Xcode/SDK macOS ngoài phần cứng Apple),
  không phải thiếu cấu hình.
- Muốn chỉ định target tường minh: `node scripts/build-cross-platform.mjs --targets linux,windows`.

File cài đặt ra `dist/<platform>-<arch>/` (vd `dist/linux-x64/k8sql_0.1.0_amd64.deb`).

**Chi tiết bên trong** (dùng khi cần debug từng bước riêng lẻ, tương đương những gì
`scripts/build-cross-platform.mjs` gọi tự động):

```bash
# 1. Đóng gói Node backend thành 1 binary SEA (server/build/k8sql-server)
cd server && npm run build:sea

# 2. Copy vào src-tauri/binaries/ đúng tên target-triple (lấy triple qua `rustc -Vv`)
cp build/k8sql-server ../src-tauri/binaries/k8sql-server-<target-triple>
chmod +x ../src-tauri/binaries/k8sql-server-<target-triple>

# 3. Build installer (Linux ví dụ .deb — AppImage cần FUSE hoạt động trên máy build, không phải
#    lúc nào cũng có sẵn, xem cảnh báo trong scripts/lib/build-native.mjs)
cd ../src-tauri && cargo tauri build --bundles deb
```

Máy đích sau khi cài **không cần Node.js** — binary SEA tự mang runtime.

### Cross-build Windows từ Linux

Bước Node SEA cho Windows **build được từ Linux, không cần Docker** — chỉ cần tải `node.exe` bản
Windows thật (từ nodejs.org) làm nơi `postject` tiêm blob vào (đã tự verify: `postject` là module
WASM portable, tự nhận diện định dạng PE từ magic bytes của chính file, không phụ thuộc OS đang
chạy). Phần vỏ Tauri/Rust (GUI + trình cài NSIS) mới thật sự cần cross-compile — dùng Docker
(`docker/windows-cross.Dockerfile`, target `x86_64-pc-windows-gnu` qua MinGW).

**Đây là hướng KHÔNG CHÍNH THỨC** — Tauri khuyến nghị build native trên Windows thật hoặc CI runner
Windows (MSVC toolchain). Cross-compile bằng GNU toolchain có rủi ro thật chưa verify hết: tương tác
WebView2/COM bindings hoặc script NSIS có thể lỗi. Nếu `scripts/build-cross-platform.mjs` báo lỗi ở
bước này, dùng máy/VM Windows thật hoặc GitLab CI runner Windows thay vì cố sửa tiếp hướng Docker.
