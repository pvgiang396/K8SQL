// Entry point mới của sidecar Node — thay cho app.listen() cuối app.js gốc k8sctl.
// (Phase 3 sẽ chèn envShim.ts TRƯỚC dòng createApp() bên dưới, đúng ràng buộc "nạp env trước khi
// require controller/service" ghi trong k8sctl/CLAUDE.md — chỉ đổi nguồn nạp từ .env sang
// SQLite+keychain.)

// require() thuần (không dùng `import`/`import ... = require()`) — file này chạy trực tiếp qua
// Node's native TS type-stripping trong dev (`node src/bootstrap.ts`, xem README) mà KHÔNG set
// "type":"module" trong package.json; type-stripping chỉ tước type annotation, không transform cú
// pháp module TS-only, nên phải giữ nguyên cú pháp CommonJS hợp lệ. esbuild (Phase 2 SEA) cũng xử
// lý require() bình thường khi bundle sang CJS, không mất tương thích.
const path: typeof import("node:path") = require("node:path");
const { createApp } = require("../legacy/app");

function readArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

// SEA bundle mọi thứ vào 1 file rồi nhúng vào binary — __dirname không còn trỏ đúng vị trí file
// gốc trên đĩa trong trường hợp đó. Đã THỬ VÀ BỎ suy đoán `path.dirname(process.execPath)` (giả
// định public/ luôn nằm CẠNH binary sidecar) — sai thật trên .deb: Tauri đặt externalBin ở
// `/usr/bin/k8sql-server` nhưng resource `public/` lại ở `/usr/lib/k8sql/public/` (2 thư mục khác
// nhau, layout do Tauri/từng loại bundle .deb/.AppImage/.msi/.dmg tự quyết định, không có quan hệ
// cố định nào để suy ra bằng đường dẫn tương đối). Fix: Rust (sidecar.rs::spawn_release()) tự
// resolve đúng resource dir qua Tauri path API rồi truyền thẳng qua `--public-dir`, không cho Node
// tự đoán nữa.
function resolvePublicDir(): string {
  const explicit = readArg("public-dir");
  if (explicit) return explicit;
  // Không truyền --public-dir → dev mode (`node src/bootstrap.ts` hoặc `spawn_dev()`), public/
  // nằm ở server/public, suy ra từ vị trí thật của file này (__dirname = server/src).
  return path.join(__dirname, "..", "public");
}

const port = Number(readArg("port") || process.env.PORT || 4210);
const host = readArg("host") || process.env.HOST || "127.0.0.1";

const app = createApp({ publicDir: resolvePublicDir() });

const server = app.listen(port, host, () => {
  console.log(`k8sql sidecar listening on ${host}:${port}`);
  // Tauri (sidecar.rs) đọc dòng này qua stdout để biết port thật đã bind thành công, dùng khi
  // port 4210 mặc định bị chiếm và Rust cần đọc lại port thật đã dò được — xem "Sidecar lifecycle".
  console.log(`K8SQL_READY port=${port}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
