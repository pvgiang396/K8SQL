// Import 1 lần từ file export cũ của k8sctl (`GET /sql/config/export`, dạng {environments: [...]})
// vào SQLite + keychain — chạy TRONG tiến trình sidecar đang sống (không phải script standalone
// riêng biệt) vì chỉ sidecar mới có sẵn bearer token gọi native_bridge (keychain) — token sinh
// random mỗi phiên, không script bên ngoài nào biết được. `server/scripts/import-k8sctl-config.mjs`
// chỉ là 1 HTTP client mỏng POST file JSON tới route `/internal/import-k8sctl-config` (đăng ký
// trong bootstrap.ts) gọi vào module này.
//
// LƯU Ý: file export cũ CHỈ chứa DB environments, KHÔNG có thông tin Rancher cluster (URL/token) —
// entry nào tham chiếu `rancherKey` chưa từng có trong SQLite sẽ được tạo 1 dòng placeholder
// (rancher_url/cluster_id rỗng) để FK hợp lệ, cần user tự điền URL+token thật qua Settings UI sau.

const { getDb } = require("../config/db.ts");
const keychainClient = require("../secrets/keychainClient.ts");

interface OldExportEnvironment {
  name: string;
  description?: string;
  connectionStringEnvVar?: string;
  allowWrite?: boolean;
  mode?: string;
  domain?: string;
  rancherKey?: string;
  namespace?: string;
  dbHost?: string;
  dbPort?: string | number;
  projectId?: string;
  existingPodName?: string;
  mongoDriver?: string;
  connectionString: string;
}

interface ImportSummary {
  dbEnvironmentsImported: number;
  dbEnvironmentsSkipped: number;
  rancherPlaceholdersCreated: string[];
  warnings: string[];
}

function toTunnelTemplate(connectionString: string, dbHost?: string, dbPort?: string | number): string {
  if (connectionString.includes("__HOST__")) return connectionString;
  if (dbHost && dbPort !== undefined) {
    const hostPort = `${dbHost}:${dbPort}`;
    if (connectionString.includes(hostPort)) {
      return connectionString.replace(hostPort, "__HOST__");
    }
  }
  return connectionString;
}

function ensureRancherClusterPlaceholder(
  db: ReturnType<typeof getDb>,
  rancherKey: string,
  created: string[]
): number {
  const existing = db.prepare("SELECT id FROM rancher_clusters WHERE name = ?").get(rancherKey) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;

  const secretRef = `rancher:${rancherKey}:token`;
  const info = db
    .prepare(
      `INSERT INTO rancher_clusters (name, rancher_url, cluster_id, insecure_tls, description, secret_ref)
       VALUES (?, '', '', 0, ?, ?)`
    )
    .run(
      rancherKey,
      "TODO: tạo tự động bởi import script — điền Rancher URL + token thật qua Settings UI",
      secretRef
    );
  created.push(rancherKey);
  return Number(info.lastInsertRowid);
}

async function importDbEnvironmentsExport(data: {
  environments: OldExportEnvironment[];
}): Promise<ImportSummary> {
  const db = getDb();
  const summary: ImportSummary = {
    dbEnvironmentsImported: 0,
    dbEnvironmentsSkipped: 0,
    rancherPlaceholdersCreated: [],
    warnings: [],
  };

  for (const env of data.environments || []) {
    const existing = db.prepare("SELECT id FROM db_environments WHERE name = ?").get(env.name);
    if (existing) {
      summary.dbEnvironmentsSkipped += 1;
      summary.warnings.push(`"${env.name}" đã tồn tại trong SQLite — bỏ qua (không ghi đè).`);
      continue;
    }

    let rancherClusterId: number | null = null;
    if (env.rancherKey) {
      rancherClusterId = ensureRancherClusterPlaceholder(
        db,
        env.rancherKey,
        summary.rancherPlaceholdersCreated
      );
    }

    const secretRef = `db-env:${env.name}:connstr`;
    const secretValue =
      env.mode === "k8s-tunnel"
        ? toTunnelTemplate(env.connectionString, env.dbHost, env.dbPort)
        : env.connectionString;

    db.prepare(
      `INSERT INTO db_environments
        (name, description, mode, domain, rancher_cluster_id, namespace, db_host, db_port,
         project_id, existing_pod_name, allow_write, engine, mongo_driver, secret_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      env.name,
      env.description || "",
      env.mode || null,
      env.domain || null,
      rancherClusterId,
      env.namespace || null,
      env.dbHost || null,
      env.dbPort !== undefined ? Number(env.dbPort) : null,
      env.projectId || null,
      env.existingPodName || null,
      env.allowWrite ? 1 : 0,
      null,
      env.mongoDriver || null,
      secretRef
    );

    await keychainClient.setSecret(secretRef, secretValue);
    summary.dbEnvironmentsImported += 1;
  }

  return summary;
}

module.exports = { importDbEnvironmentsExport };
