// Client HTTP mỏng — POST nội dung file export cũ của k8sctl (dạng {environments:[...]}, lấy từ
// `GET /sql/config/export` trên k8sctl gốc) tới sidecar k8sql ĐANG CHẠY (`POST
// /internal/import-k8sctl-config`, xem src/migration/importFromK8sctl.ts) để import vào SQLite +
// keychain. PHẢI chạy khi app k8sql đang mở (không phải standalone) — chỉ sidecar mới có sẵn bearer
// token gọi native_bridge/keychain.
//
// Cách dùng:
//   node scripts/import-k8sctl-config.mjs <đường-dẫn-file-export.json> [--port 4210]

import fs from "node:fs";

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith("--"));
const portIdx = args.indexOf("--port");
const port = portIdx !== -1 ? args[portIdx + 1] : "4210";

if (!filePath) {
  console.error("Cách dùng: node scripts/import-k8sctl-config.mjs <file.json> [--port 4210]");
  process.exit(1);
}

const raw = fs.readFileSync(filePath, "utf8");
const data = JSON.parse(raw);

const res = await fetch(`http://127.0.0.1:${port}/internal/import-k8sctl-config`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});

const body = await res.json();

if (!res.ok || !body.success) {
  console.error("Import thất bại:", body.message || res.statusText);
  process.exit(1);
}

console.log("Import xong:");
console.log(`  - DB environments đã import: ${body.data.dbEnvironmentsImported}`);
console.log(`  - DB environments bỏ qua (đã tồn tại): ${body.data.dbEnvironmentsSkipped}`);
if (body.data.rancherPlaceholdersCreated.length > 0) {
  console.log(
    `  - Rancher cluster PLACEHOLDER (chưa có URL/token thật, cần điền qua Settings UI): ${body.data.rancherPlaceholdersCreated.join(", ")}`
  );
}
if (body.data.warnings.length > 0) {
  console.log("  - Cảnh báo:");
  for (const w of body.data.warnings) console.log(`      ${w}`);
}
