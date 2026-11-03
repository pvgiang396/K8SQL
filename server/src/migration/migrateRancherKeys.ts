// Đổi rancher_clusters.name (và secret_ref keychain) sang công thức
// deriveRancherKey(url, token, username) = <key từ URL>_<username || token trước ':'>.
// Idempotent: đã đúng tên thì bỏ qua. FK db_environments/namespace_groups trỏ theo id số,
// không cần sửa — list* JOIN theo name nên rancherKey trên API tự ra tên mới.

const { getDb } = require("../config/db.ts");
const { deriveRancherKey } = require("../config/rancherKey.ts");
const keychainClient = require("../secrets/keychainClient.ts");

interface ClusterRow {
  id: number;
  name: string;
  rancher_url: string;
  secret_ref: string;
  username: string | null;
}

async function migrateRancherClusterKeys(): Promise<{ from: string; to: string }[]> {
  if (!keychainClient.isConfigured()) return [];

  const db = getDb();
  const rows = db
    .prepare("SELECT id, name, rancher_url, secret_ref, username FROM rancher_clusters")
    .all() as ClusterRow[];
  const renamed: { from: string; to: string }[] = [];

  for (const row of rows) {
    let token: string | undefined;
    try {
      token = await keychainClient.getSecret(row.secret_ref);
    } catch {
      token = undefined;
    }
    if (!token && !String(row.username || "").trim()) continue;

    const newName = deriveRancherKey(row.rancher_url, token, row.username);
    if (!newName) continue;

    let name = row.name;
    if (newName !== row.name) {
      const clash = db.prepare("SELECT id FROM rancher_clusters WHERE name = ? AND id != ?").get(newName, row.id) as
        | { id: number }
        | undefined;
      if (clash) continue;
      db.prepare("UPDATE rancher_clusters SET name = ?, updated_at = datetime('now') WHERE id = ?").run(newName, row.id);
      name = newName;
      renamed.push({ from: row.name, to: newName });
    }

    const newSecretRef = `rancher:${name}:token`;
    if (newSecretRef !== row.secret_ref) {
      try {
        await keychainClient.setSecret(newSecretRef, token);
        db.prepare("UPDATE rancher_clusters SET secret_ref = ? WHERE id = ?").run(newSecretRef, row.id);
        await keychainClient.deleteSecret(row.secret_ref).catch(() => {});
      } catch {
        // Tên đã đúng; secret_ref cũ vẫn đọc được token.
      }
    }
  }

  return renamed;
}

module.exports = { migrateRancherClusterKeys };
