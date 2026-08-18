// Trước đây file này "materialize" SQLite+keychain ra config/rancher-clusters.json +
// config/db-environments.json + config/namespaces.json + config/kubeconfigs/*.yaml + .env để
// legacy/services/*.js đọc qua fs.readFileSync — ĐÃ BỎ (xem k8sql/CLAUDE.md mục "Đọc thẳng SQLite
// lúc runtime"): legacy/services giờ đọc thẳng SQLite qua
// src/config/repository/settingsRepo.ts's listRancherClusters()/listDbEnvironments()/
// listNamespaceGroups() (node:sqlite là đồng bộ, không cần lớp file trung gian nữa), và
// kube.service.js đọc kubeconfig qua keychainClient.getSecret()+KubeConfig.loadFromString() thay vì
// loadFromFile(). Hàm còn lại ở đây CHỈ populate process.env[secretEnvVar] — bước này KHÔNG phải
// file I/O (in-memory), giữ lại vì nhiều nơi (rancher.client.js/providers/*/query.js) đọc secret
// đồng bộ qua process.env, tránh phải đổi hàng loạt call site đó sang await keychain trực tiếp.

const { getDb } = require("../config/db.ts");
const keychainClient = require("./keychainClient.ts");

function deriveTokenEnvVar(clusterName: string): string {
  return `${clusterName.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_TOKEN`;
}

function deriveConnStringEnvVar(envName: string): string {
  return `${envName.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_URL`;
}

// Nạp process.env[tokenEnvVar/connectionStringEnvVar] cho MỌI rancher_clusters/db_environments từ
// keychain — gọi 1 lần lúc khởi động sidecar (bootstrap.ts) + lại mỗi khi 1 route ghi secret mới
// (applySettings/saveRancherClusters/saveDbEnvironments/importConfig/clearConfig...) để process.env
// luôn đồng bộ ngay khi request đó trả lời. KHÔNG xoá key cũ của row đã bị xoá khỏi SQLite (rough
// edge nhỏ đã biết, vô hại — không ai đọc lại theo tên cũ vì row chủ đã mất, chỉ tồn tại tới khi
// restart process).
async function refreshProcessEnvSecrets(): Promise<void> {
  const db = getDb();

  const clusters = db.prepare("SELECT name, secret_ref FROM rancher_clusters").all() as
    { name: string; secret_ref: string }[];
  for (const c of clusters) {
    const token = await keychainClient.getSecret(c.secret_ref);
    if (token !== undefined) process.env[deriveTokenEnvVar(c.name)] = token;
  }

  const environments = db.prepare("SELECT name, secret_ref FROM db_environments").all() as
    { name: string; secret_ref: string }[];
  for (const e of environments) {
    const value = await keychainClient.getSecret(e.secret_ref);
    if (value !== undefined) process.env[deriveConnStringEnvVar(e.name)] = value;
  }
}

module.exports = { refreshProcessEnvSecrets, deriveTokenEnvVar, deriveConnStringEnvVar };
