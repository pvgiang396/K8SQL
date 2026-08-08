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

```bash
# 1. Đóng gói Node backend thành 1 binary SEA (server/build/k8sql-server)
cd server && npm run build:sea

# 2. Copy vào src-tauri/binaries/ đúng tên target-triple (lấy triple qua `rustc -Vv`)
cp build/k8sql-server ../src-tauri/binaries/k8sql-server-<target-triple>
chmod +x ../src-tauri/binaries/k8sql-server-<target-triple>

# 3. Build installer (Linux ví dụ .deb/.AppImage)
cd ../src-tauri && cargo tauri build --bundles deb,appimage
```

SEA build phải chạy TRÊN đúng OS/arch đích (không cross-compile được) — xem "Sidecar packaging"
trong plan/CLAUDE.md. Máy đích sau khi cài **không cần Node.js** — binary SEA tự mang runtime.
