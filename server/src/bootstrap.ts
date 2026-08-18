// Entry point mới của sidecar Node — thay cho app.listen() cuối app.js gốc k8sctl.
//
// require() thuần (không dùng `import`/`import ... = require()`/`export =`) — file này chạy trực
// tiếp qua Node's native TS type-stripping trong dev (`node src/bootstrap.ts`), strip-only mode
// KHÔNG hỗ trợ các cú pháp TS-only đó (đã tự verify, throw `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`).
// esbuild (Phase 2 SEA) cũng xử lý require() bình thường khi bundle sang CJS, không mất tương thích.
const path: typeof import("node:path") = require("node:path");
// require() giữa các file .ts phải khai rõ đuôi ".ts" — Node's native TS type-stripping (dev mode,
// `node src/bootstrap.ts`) KHÔNG tự resolve extension .ts như .js (đã tự verify, MODULE_NOT_FOUND
// nếu bỏ đuôi); esbuild (Phase 2 SEA) resolve đúng cả 2 cách nên không mất tương thích khi bundle.
const { getDb } = require("./config/db.ts");
const { refreshProcessEnvSecrets } = require("./secrets/envShim.ts");
const { importDbEnvironmentsExport } = require("./migration/importFromK8sctl.ts");
const keychainClient = require("./secrets/keychainClient.ts");
const { runSelfUpdate } = require("./selfUpdate.ts");
const { clearAllConfig } = require("./clearConfig.ts");

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
// tự đoán nữa. CÙNG lý do đó áp dụng cho `--data-dir` (SQLite + config materialize) bên dưới.
function resolvePublicDir(): string {
  const explicit = readArg("public-dir");
  if (explicit) return explicit;
  // Không truyền --public-dir → dev mode (`node src/bootstrap.ts` hoặc `spawn_dev()`), public/
  // nằm ở server/public, suy ra từ vị trí thật của file này (__dirname = server/src).
  return path.join(__dirname, "..", "public");
}

function resolveDataDir(): string {
  const explicit = readArg("data-dir");
  if (explicit) return explicit;
  return path.join(__dirname, "..", ".data");
}

async function main() {
  const dataDir = resolveDataDir();

  // legacy/utils/base-dir.js đọc process.env.K8SQL_BASE_DIR — PHẢI set trước khi require
  // legacy/app.js (kéo theo mọi controller/service), đúng ràng buộc "nạp env trước khi require
  // controller/service" ghi trong k8sctl/CLAUDE.md gốc. legacy/services giờ đọc thẳng SQLite (không
  // qua config/*.json nữa, xem envShim.ts) nhưng vẫn cần K8SQL_BASE_DIR cho vài chỗ khác dùng
  // getBaseDir() (kubeconfig ad-hoc apply, logger...).
  process.env.K8SQL_BASE_DIR = dataDir;

  getDb(); // đảm bảo schema SQLite đã tồn tại trước khi đọc.
  await refreshProcessEnvSecrets();

  // eslint-disable-next-line global-require
  const { createApp } = require("../legacy/app");

  const port = Number(readArg("port") || process.env.PORT || 4210);
  const host = readArg("host") || process.env.HOST || "127.0.0.1";

  const app = createApp({
    publicDir: resolvePublicDir(),
    registerExtraRoutes(expressApp: import("express").Express) {
      // Route MỚI, không có ở k8sctl gốc — dùng bởi server/scripts/import-k8sctl-config.mjs (chạy
      // trong đúng tiến trình sidecar để có sẵn bearer token gọi native_bridge/keychain, xem
      // comment đầu src/migration/importFromK8sctl.ts).
      expressApp.post("/internal/import-k8sctl-config", async (req: import("express").Request, res: import("express").Response) => {
        try {
          const summary = await importDbEnvironmentsExport(req.body);
          // SQLite vừa đổi — refresh process.env NGAY để secret mới đọc được mà không cần restart
          // sidecar (legacy/services giờ đọc structure trực tiếp từ SQLite mỗi lần gọi, chỉ secret
          // qua process.env mới cần refresh tường minh).
          await refreshProcessEnvSecrets();
          res.json({ success: true, data: summary });
        } catch (err) {
          res.status(500).json({ success: false, message: (err as Error).message });
        }
      });

      // Proxy mỏng sang native_bridge.rs (chỉ Rust gọi được tauri-plugin-autostart) — UI
      // (public/shared/settings-modal.js) gọi 2 route Node này same-origin, không cần biết gì về
      // native bridge/token phía dưới.
      expressApp.get("/native/autostart", async (_req: import("express").Request, res: import("express").Response) => {
        try {
          const enabled = await keychainClient.getAutostart();
          res.json({ success: true, enabled });
        } catch (err) {
          res.status(500).json({ success: false, message: (err as Error).message });
        }
      });
      expressApp.post("/native/autostart", async (req: import("express").Request, res: import("express").Response) => {
        try {
          const enabled = await keychainClient.setAutostart(Boolean(req.body?.enabled));
          res.json({ success: true, data: { enabled } });
        } catch (err) {
          res.status(500).json({ success: false, message: (err as Error).message });
        }
      });

      // Nút "Cập nhật" cạnh icon "Cấu hình" (public/index.html) — xem src/selfUpdate.ts cho toàn
      // bộ logic git pull + rebuild + cài lại (qua cmdctl) + tự restart. Có thể chạy lâu (build
      // Tauri ~1 phút) nên không set timeout riêng ở tầng route, để nguyên default Express/http.
      expressApp.post("/internal/self-update", async (_req: import("express").Request, res: import("express").Response) => {
        try {
          const result = await runSelfUpdate();
          res.json({ success: true, data: result });
        } catch (err) {
          res.status(500).json({ success: false, message: (err as Error).message });
        }
      });

      // Nút "Làm sạch cấu hình" (🧨, cạnh "Cập nhật" trong public/index.html) — xem src/clearConfig.ts.
      expressApp.post("/internal/clear-config", async (_req: import("express").Request, res: import("express").Response) => {
        try {
          const result = await clearAllConfig();
          res.json({ success: true, data: result });
        } catch (err) {
          res.status(500).json({ success: false, message: (err as Error).message });
        }
      });
    },
  });

  const server = app.listen(port, host, () => {
    console.log(`k8sql sidecar listening on ${host}:${port}`);
    // Tauri (sidecar.rs) đọc dòng này qua stdout để biết port thật đã bind thành công, dùng khi
    // port 4210 mặc định bị chiếm và Rust cần đọc lại port thật đã dò được — xem "Sidecar lifecycle".
    console.log(`K8SQL_READY port=${port}`);
  });

  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}

main().catch((err) => {
  console.error("[k8sql-server] Lỗi khởi động:", err);
  process.exit(1);
});
