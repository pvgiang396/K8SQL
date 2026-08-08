// Entry point mới của sidecar Node — thay cho app.listen() cuối app.js gốc k8sctl.
// Phase 1 (hiện tại): chỉ đọc port/host từ CLI arg hoặc process.env, KHÔNG có SQLite/keychain
// (đó là việc của Phase 3 — src/config/db.ts + src/secrets/envShim.ts sẽ chèn vào TRƯỚC dòng
// require("../legacy/app") khi triển khai, đúng ràng buộc "nạp env trước khi require
// controller/service" ghi trong k8sctl/CLAUDE.md).

function readArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

const port = Number(readArg("port") || process.env.PORT || 4210);
const host = readArg("host") || process.env.HOST || "127.0.0.1";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require("../legacy/app");

const server = app.listen(port, host, () => {
  console.log(`k8sql sidecar listening on ${host}:${port}`);
  // Tauri (sidecar.rs) đọc dòng này qua stdout để biết port thật đã bind thành công, dùng khi
  // port 4210 mặc định bị chiếm và Rust cần đọc lại port thật đã dò được — xem "Sidecar lifecycle".
  console.log(`K8SQL_READY port=${port}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
