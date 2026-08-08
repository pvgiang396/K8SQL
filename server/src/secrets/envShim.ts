// Dựng lại config/rancher-clusters.json + config/db-environments.json + config/namespaces.json +
// .env (đúng shape legacy code đang đọc, xem legacy/utils/base-dir.js) TỪ SQLite + keychain, MỖI
// LẦN sidecar khởi động — SQLite/keychain là nguồn sự thật duy nhất, các file này chỉ là bản
// "materialize" tạm để tái dùng 100% logic đọc file có sẵn trong legacy/services/*.js mà KHÔNG
// phải viết lại từng file (kube.service.js, rancher.client.js, db-environment.service.js...).
// Route ghi (`POST /settings/*`) đã được viết lại để ghi thẳng vào SQLite+keychain (xem
// legacy/services/settings.service.js phần đã sửa) — không ghi trực tiếp vào các file .json này.

const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const { getDb } = require("../config/db.ts");
const keychainClient = require("./keychainClient.ts");

interface RancherClusterRow {
  id: number;
  name: string;
  rancher_url: string;
  cluster_id: string;
  insecure_tls: number;
  description: string | null;
  secret_ref: string;
}

interface DbEnvironmentRow {
  id: number;
  name: string;
  description: string | null;
  mode: string | null;
  domain: string | null;
  rancher_cluster_id: number | null;
  namespace: string | null;
  db_host: string | null;
  db_port: number | null;
  project_id: string | null;
  existing_pod_name: string | null;
  allow_write: number;
  engine: string | null;
  mongo_driver: string | null;
  secret_ref: string;
}

interface NamespaceGroupRow {
  id: number;
  provider: string;
  name: string;
  namespace: string;
  rancher_cluster_id: number | null;
  kubeconfig_secret_ref: string | null;
  services_json: string;
  db_json: string | null;
}

function deriveTokenEnvVar(clusterName: string): string {
  return `${clusterName.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_TOKEN`;
}

function deriveConnStringEnvVar(envName: string): string {
  return `${envName.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_URL`;
}

async function materializeLegacyConfig(baseDir: string): Promise<void> {
  const db = getDb();
  const configDir = path.join(baseDir, "config");
  fs.mkdirSync(configDir, { recursive: true });

  const clusters = db.prepare("SELECT * FROM rancher_clusters").all() as RancherClusterRow[];
  const clusterById = new Map(clusters.map((c) => [c.id, c]));

  const envVars: Record<string, string> = {};
  const rancherClustersJson = [];
  for (const c of clusters) {
    const tokenEnvVar = deriveTokenEnvVar(c.name);
    const token = await keychainClient.getSecret(c.secret_ref);
    if (token !== undefined) envVars[tokenEnvVar] = token;
    rancherClustersJson.push({
      name: c.name,
      rancherUrl: c.rancher_url,
      clusterId: c.cluster_id,
      tokenEnvVar,
      insecureTLS: Boolean(c.insecure_tls),
      description: c.description || "",
    });
  }
  fs.writeFileSync(
    path.join(configDir, "rancher-clusters.json"),
    JSON.stringify(rancherClustersJson, null, 2)
  );

  const dbEnvironments = db.prepare("SELECT * FROM db_environments").all() as DbEnvironmentRow[];
  const dbEnvironmentsJson = [];
  for (const e of dbEnvironments) {
    const connectionStringEnvVar = deriveConnStringEnvVar(e.name);
    const value = await keychainClient.getSecret(e.secret_ref);
    if (value !== undefined) envVars[connectionStringEnvVar] = value;
    const rancherCluster = e.rancher_cluster_id ? clusterById.get(e.rancher_cluster_id) : undefined;
    dbEnvironmentsJson.push({
      name: e.name,
      description: e.description || "",
      connectionStringEnvVar,
      mode: e.mode || undefined,
      domain: e.domain || undefined,
      rancherKey: rancherCluster?.name || undefined,
      namespace: e.namespace || undefined,
      dbHost: e.db_host || undefined,
      dbPort: e.db_port || undefined,
      projectId: e.project_id || undefined,
      existingPodName: e.existing_pod_name || undefined,
      allowWrite: Boolean(e.allow_write),
      engine: e.engine || undefined,
      mongoDriver: e.mongo_driver || undefined,
    });
  }
  fs.writeFileSync(
    path.join(configDir, "db-environments.json"),
    JSON.stringify(dbEnvironmentsJson, null, 2)
  );

  const groups = db.prepare("SELECT * FROM namespace_groups").all() as NamespaceGroupRow[];
  const namespacesJson = [];
  for (const g of groups) {
    const domains = db
      .prepare("SELECT url, env FROM namespace_group_domains WHERE group_id = ?")
      .all(g.id) as { url: string; env: string | null }[];
    const rancherCluster = g.rancher_cluster_id ? clusterById.get(g.rancher_cluster_id) : undefined;
    let configPath: string | undefined;
    if (g.provider === "kubeconfig" && g.kubeconfig_secret_ref) {
      const yamlContent = await keychainClient.getSecret(g.kubeconfig_secret_ref);
      if (yamlContent !== undefined) {
        const kubeconfigDir = path.join(configDir, "kubeconfigs");
        fs.mkdirSync(kubeconfigDir, { recursive: true });
        const fileName = `${g.name.replace(/[^A-Za-z0-9_-]/g, "_")}.yaml`;
        fs.writeFileSync(path.join(kubeconfigDir, fileName), yamlContent);
        configPath = path.join("config", "kubeconfigs", fileName);
      }
    }
    namespacesJson.push({
      name: g.name,
      provider: g.provider,
      rancherCluster: rancherCluster?.name || undefined,
      configPath,
      namespace: g.namespace,
      domains: domains.map((d) => ({ url: d.url, env: d.env || undefined })),
      services: JSON.parse(g.services_json),
      db: g.db_json ? JSON.parse(g.db_json) : undefined,
    });
  }
  fs.writeFileSync(path.join(configDir, "namespaces.json"), JSON.stringify(namespacesJson, null, 2));

  const envContent = Object.entries(envVars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  fs.writeFileSync(path.join(baseDir, ".env"), envContent + (envContent ? "\n" : ""));

  for (const [k, v] of Object.entries(envVars)) {
    process.env[k] = v;
  }
}

module.exports = { materializeLegacyConfig, deriveTokenEnvVar, deriveConnStringEnvVar };
