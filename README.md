# k8sql

Desktop app (Windows/macOS/Linux) cho Kubernetes/Rancher Tool Server + SQL Tool — kế thừa backend
[k8sctl](https://gitlab.com/pvgiang396/k8sctl) qua Tauri (Rust) + Node.js sidecar, thay cho mô hình
"local server + trình duyệt kiosk-mode + service OS" hiện tại của k8sctl.

k8sctl tiếp tục chạy song song trong quá trình chuyển tiếp — xem chi tiết quyết định kiến trúc,
schema lưu trữ, và lộ trình từng phase trong [`CLAUDE.md`](CLAUDE.md).

## Trạng thái hiện tại

**Phase 1** (Tauri shell load UI hiện tại, chưa động vào config) — đang triển khai:

- `server/legacy/` — toàn bộ controller/service/util port nguyên vẹn từ k8sctl (không sửa logic).
- `server/src/bootstrap.ts` — entry mới thay `app.listen()` cuối `app.js` gốc.
- `src-tauri/` — Rust shell, Phase 1 spawn `node server/src/bootstrap.ts` ở dev mode (chưa đóng gói
  Node SEA — xem Phase 2 trong `CLAUDE.md`).

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
