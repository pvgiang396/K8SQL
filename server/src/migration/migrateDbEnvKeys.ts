// Nâng cấp các URL KEY cũ từ connection string lưu trong keychain. Giữ nguyên id và secret_ref
// để không làm mất tham chiếu/secret; bỏ qua key bị trùng thay vì ghi đè connection khác.
const { getDb } = require("../config/db.ts");
const { deriveDbEnvKey } = require("../config/dbEnvKey.ts");
const keychainClient = require("../secrets/keychainClient.ts");

async function migrateDbEnvKeys(): Promise<{ from: string; to: string }[]> {
  if (!keychainClient.isConfigured()) return [];
  const db = getDb();
  const rows = db.prepare("SELECT id, name, secret_ref FROM db_environments").all() as
    { id: number; name: string; secret_ref: string }[];
  const renamed: { from: string; to: string }[] = [];
  for (const row of rows) {
    let connectionString: string | undefined;
    try {
      connectionString = await keychainClient.getSecret(row.secret_ref);
    } catch {
      continue;
    }
    if (!connectionString) continue;
    const name = deriveDbEnvKey(row.name, connectionString);
    if (name === row.name) continue;
    const clash = db.prepare("SELECT id FROM db_environments WHERE name = ? AND id != ?").get(name, row.id);
    if (clash) continue;
    db.prepare("UPDATE db_environments SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name, row.id);
    renamed.push({ from: row.name, to: name });
  }
  return renamed;
}

module.exports = { migrateDbEnvKeys };
