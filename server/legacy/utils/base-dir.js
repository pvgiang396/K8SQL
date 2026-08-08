// Helper MỚI (không có ở k8sctl gốc). Nhiều file legacy tính đường dẫn config/.env/logs qua
// `path.join(__dirname, "..", ...)` — đúng khi chạy `node app.js` từ đúng vị trí trong repo gốc,
// nhưng SAI dưới SEA: đã tự verify thực nghiệm `__dirname` trong bundle SEA luôn bằng
// `path.dirname(process.execPath)` (thư mục chứa BINARY, không phải thư mục source gốc) — với
// layout .deb thật (`/usr/bin/k8sql-server`), `__dirname/..` sẽ trỏ vào `/`  (filesystem root,
// không ghi được). `bootstrap.ts` set `process.env.K8SQL_BASE_DIR` (dùng chung `--data-dir` mà
// Rust đã resolve cho SQLite) TRƯỚC khi require bất kỳ legacy service nào — các service đó gọi
// `getBaseDir()` thay vì tự tính qua `__dirname` nữa.
function getBaseDir() {
  return process.env.K8SQL_BASE_DIR || require("path").join(__dirname, "..");
}

module.exports = { getBaseDir };
