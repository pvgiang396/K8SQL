// SQLite (node:sqlite, built-in Node ≥22.5, KHÔNG cần native addon — giữ tương thích Node SEA)
// cho dữ liệu cấu hình có cấu trúc. Giá trị secret KHÔNG bao giờ nằm ở đây — chỉ lưu `secret_ref`
// (khoá tham chiếu tới OS keychain qua native_bridge, xem secrets/keychainClient.ts).

// Cú pháp require() thuần (không `import`/`export =`) — chạy trực tiếp qua Node's native TS
// type-stripping trong dev, đã tự verify 2 cú pháp TS-only này KHÔNG được strip-only mode hỗ trợ
// (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`), xem thêm comment tương tự trong bootstrap.ts.
const path: typeof import("node:path") = require("node:path");
const fs: typeof import("node:fs") = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rancher_clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  rancher_url TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  insecure_tls INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  secret_ref TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS db_environments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  mode TEXT,
  domain TEXT,
  rancher_cluster_id INTEGER REFERENCES rancher_clusters(id),
  namespace TEXT,
  db_host TEXT,
  db_port INTEGER,
  project_id TEXT,
  existing_pod_name TEXT,
  allow_write INTEGER NOT NULL DEFAULT 0,
  engine TEXT,
  mongo_driver TEXT,
  secret_ref TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS namespace_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE,
  namespace TEXT NOT NULL,
  rancher_cluster_id INTEGER REFERENCES rancher_clusters(id),
  project_id TEXT,
  kubeconfig_secret_ref TEXT,
  services_json TEXT NOT NULL,
  db_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS namespace_group_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES namespace_groups(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  env TEXT
);

CREATE TABLE IF NOT EXISTS migration_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  summary_json TEXT
);
`;

const SCHEMA_VERSION = "1";

let dbInstance: InstanceType<typeof DatabaseSync> | undefined;

// Singleton trong 1 tiến trình sidecar — mọi module (settings service, import script khi chạy
// trong cùng tiến trình) dùng chung 1 kết nối, tránh khoá file SQLite chồng chéo.
function getDb(): InstanceType<typeof DatabaseSync> {
  if (dbInstance) return dbInstance;

  const dataDir = readArg("data-dir") || path.join(__dirname, "..", "..", ".data");
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "k8sql.db");

  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);

  // Migration idempotent cho DB tạo trước khi có cột project_id (2026-08-11) — CREATE TABLE IF NOT
  // EXISTS ở trên không tự thêm cột mới vào bảng đã tồn tại, phải tự ALTER. SQLite không hỗ trợ
  // "ADD COLUMN IF NOT EXISTS" nên phải tự kiểm tra qua PRAGMA table_info trước.
  const namespaceGroupCols = db.prepare("PRAGMA table_info(namespace_groups)").all() as { name: string }[];
  if (!namespaceGroupCols.some((c) => c.name === "project_id")) {
    db.exec("ALTER TABLE namespace_groups ADD COLUMN project_id TEXT");
  }

  const existing = db.prepare("SELECT value FROM app_settings WHERE key = 'schemaVersion'").get();
  if (!existing) {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('schemaVersion', ?)").run(
      SCHEMA_VERSION
    );
  }

  dbInstance = db;
  return db;
}

function readArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

module.exports = { getDb };
