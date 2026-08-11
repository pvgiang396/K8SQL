// CRUD cho rancher_clusters/db_environments dùng bởi legacy/services/settings.service.js — thay
// cho ghi trực tiếp config/*.json (bị envShim.materializeLegacyConfig() ghi đè mất mỗi lần sidecar
// restart, xem k8sql/CLAUDE.md mục "Việc tồn đọng Phase 3"). UI gửi TOÀN BỘ mảng mong muốn mỗi lần
// "Áp dụng" (giữ đúng ngữ nghĩa gốc k8sctl: thêm/sửa/xoá cùng lúc qua diff với dữ liệu đã lưu).

const { getDb } = require("../db.ts");
const keychainClient = require("../../secrets/keychainClient.ts");
const { deriveTokenEnvVar, deriveConnStringEnvVar } = require("../../secrets/envShim.ts");

interface RancherClusterInput {
  name: string;
  rancherUrl: string;
  clusterId: string;
  insecureTLS?: boolean;
  description?: string;
}

interface NamespaceGroupDomainInput {
  url: string;
  env?: string;
}

interface NamespaceGroupInput {
  name: string;
  provider: string;
  rancherCluster?: string;
  projectId?: string;
  namespace: string;
  domains: NamespaceGroupDomainInput[];
  services?: Record<string, unknown>;
}

interface DbEnvironmentInput {
  name: string;
  description?: string;
  mode?: string;
  domain?: string;
  rancherKey?: string;
  namespace?: string;
  dbHost?: string;
  dbPort?: string | number;
  projectId?: string;
  existingPodName?: string;
  allowWrite?: boolean;
  engine?: string;
}

async function upsertRancherClusters(clusters: RancherClusterInput[]): Promise<void> {
  const db = getDb();
  const existing = db.prepare("SELECT id, name, secret_ref FROM rancher_clusters").all() as {
    id: number;
    name: string;
    secret_ref: string;
  }[];
  const incomingNames = new Set(clusters.map((c) => c.name));

  for (const row of existing) {
    if (!incomingNames.has(row.name)) {
      db.prepare("DELETE FROM rancher_clusters WHERE id = ?").run(row.id);
      // best-effort — xoá metadata dù keychain lỗi vẫn ưu tiên phản ánh đúng ý user (bỏ cluster
      // này), secret mồ côi trong keychain không gây hại (chỉ tốn 1 entry không dùng tới).
      await keychainClient.deleteSecret(row.secret_ref).catch(() => {});
    }
  }

  for (const c of clusters) {
    const found = existing.find((e) => e.name === c.name);
    if (found) {
      db.prepare(
        `UPDATE rancher_clusters SET rancher_url=?, cluster_id=?, insecure_tls=?, description=?, updated_at=datetime('now') WHERE id=?`
      ).run(c.rancherUrl, c.clusterId, c.insecureTLS ? 1 : 0, c.description || "", found.id);
    } else {
      const secretRef = `rancher:${c.name}:token`;
      db.prepare(
        `INSERT INTO rancher_clusters (name, rancher_url, cluster_id, insecure_tls, description, secret_ref)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(c.name, c.rancherUrl, c.clusterId, c.insecureTLS ? 1 : 0, c.description || "", secretRef);
    }
  }
}

async function upsertDbEnvironments(environments: DbEnvironmentInput[]): Promise<void> {
  const db = getDb();
  const existing = db.prepare("SELECT id, name, secret_ref FROM db_environments").all() as {
    id: number;
    name: string;
    secret_ref: string;
  }[];
  const incomingNames = new Set(environments.map((e) => e.name));

  for (const row of existing) {
    if (!incomingNames.has(row.name)) {
      db.prepare("DELETE FROM db_environments WHERE id = ?").run(row.id);
      await keychainClient.deleteSecret(row.secret_ref).catch(() => {});
    }
  }

  for (const e of environments) {
    let rancherClusterId: number | null = null;
    if (e.rancherKey) {
      const cluster = db.prepare("SELECT id FROM rancher_clusters WHERE name = ?").get(e.rancherKey) as
        | { id: number }
        | undefined;
      rancherClusterId = cluster ? cluster.id : null;
    }

    const found = existing.find((x) => x.name === e.name);
    if (found) {
      db.prepare(
        `UPDATE db_environments SET description=?, mode=?, domain=?, rancher_cluster_id=?, namespace=?,
           db_host=?, db_port=?, project_id=?, existing_pod_name=?, allow_write=?, engine=?,
           updated_at=datetime('now')
         WHERE id=?`
      ).run(
        e.description || "",
        e.mode || null,
        e.domain || null,
        rancherClusterId,
        e.namespace || null,
        e.dbHost || null,
        e.dbPort !== undefined ? Number(e.dbPort) : null,
        e.projectId || null,
        e.existingPodName || null,
        e.allowWrite ? 1 : 0,
        e.engine || null,
        found.id
      );
    } else {
      const secretRef = `db-env:${e.name}:connstr`;
      db.prepare(
        `INSERT INTO db_environments
          (name, description, mode, domain, rancher_cluster_id, namespace, db_host, db_port,
           project_id, existing_pod_name, allow_write, engine, secret_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        e.name,
        e.description || "",
        e.mode || null,
        e.domain || null,
        rancherClusterId,
        e.namespace || null,
        e.dbHost || null,
        e.dbPort !== undefined ? Number(e.dbPort) : null,
        e.projectId || null,
        e.existingPodName || null,
        e.allowWrite ? 1 : 0,
        e.engine || null,
        secretRef
      );
    }
  }
}

// namespace_groups — replace-all theo name, giống upsertRancherClusters/upsertDbEnvironments.
// namespace_group_domains xoá hết + tạo lại theo group (ON DELETE CASCADE khi xoá group, nhưng khi
// UPDATE 1 group đang tồn tại vẫn phải tự xoá domain cũ trước vì domains có thể đổi cả số lượng).
async function upsertNamespaceGroups(groups: NamespaceGroupInput[]): Promise<void> {
  const db = getDb();
  const existing = db.prepare("SELECT id, name FROM namespace_groups").all() as {
    id: number;
    name: string;
  }[];
  const incomingNames = new Set(groups.map((g) => g.name));

  for (const row of existing) {
    if (!incomingNames.has(row.name)) {
      db.prepare("DELETE FROM namespace_groups WHERE id = ?").run(row.id);
    }
  }

  for (const g of groups) {
    let rancherClusterId: number | null = null;
    if (g.rancherCluster) {
      const cluster = db.prepare("SELECT id FROM rancher_clusters WHERE name = ?").get(g.rancherCluster) as
        | { id: number }
        | undefined;
      rancherClusterId = cluster ? cluster.id : null;
    }
    const servicesJson = JSON.stringify(g.services || {});

    const found = existing.find((x) => x.name === g.name);
    let groupId: number;
    if (found) {
      db.prepare(
        `UPDATE namespace_groups SET provider=?, namespace=?, rancher_cluster_id=?, project_id=?, services_json=?
         WHERE id=?`
      ).run(g.provider, g.namespace, rancherClusterId, g.projectId || null, servicesJson, found.id);
      groupId = found.id;
    } else {
      const info = db
        .prepare(
          `INSERT INTO namespace_groups (provider, name, namespace, rancher_cluster_id, project_id, services_json)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(g.provider, g.name, g.namespace, rancherClusterId, g.projectId || null, servicesJson);
      groupId = Number(info.lastInsertRowid);
    }

    db.prepare("DELETE FROM namespace_group_domains WHERE group_id = ?").run(groupId);
    for (const d of g.domains || []) {
      db.prepare("INSERT INTO namespace_group_domains (group_id, url, env) VALUES (?, ?, ?)").run(
        groupId,
        d.url,
        d.env || null
      );
    }
  }
}

function listNamespaceGroups(): NamespaceGroupInput[] {
  const db = getDb();
  const groups = db
    .prepare(
      `SELECT ng.id, ng.provider, ng.name, ng.namespace, ng.project_id, ng.services_json, rc.name AS rancher_cluster_name
       FROM namespace_groups ng LEFT JOIN rancher_clusters rc ON rc.id = ng.rancher_cluster_id`
    )
    .all() as {
    id: number;
    provider: string;
    name: string;
    namespace: string;
    project_id: string | null;
    services_json: string;
    rancher_cluster_name: string | null;
  }[];

  return groups.map((g) => {
    const domains = db
      .prepare("SELECT url, env FROM namespace_group_domains WHERE group_id = ?")
      .all(g.id) as { url: string; env: string | null }[];
    return {
      name: g.name,
      provider: g.provider,
      rancherCluster: g.rancher_cluster_name || undefined,
      projectId: g.project_id || undefined,
      namespace: g.namespace,
      domains: domains.map((d) => ({ url: d.url, env: d.env || undefined })),
      services: JSON.parse(g.services_json),
    };
  });
}

// applySettings({values}) gửi lên map {<tokenEnvVar hoặc connectionStringEnvVar đã derive>: <secret
// thật>} — khớp NGƯỢC lại đúng cluster/db_environment nào bằng cách tự derive lại tên biến từ
// name mỗi row (deriveTokenEnvVar/deriveConnStringEnvVar, CÙNG công thức envShim.ts dùng để
// materialize — phải khớp nhau tuyệt đối, xem "Ghi chú kỹ thuật" trong CLAUDE.md nếu đổi công thức).
async function applySecretValues(values: Record<string, string>): Promise<void> {
  const db = getDb();
  const clusters = db.prepare("SELECT name, secret_ref FROM rancher_clusters").all() as {
    name: string;
    secret_ref: string;
  }[];
  const environments = db.prepare("SELECT name, secret_ref FROM db_environments").all() as {
    name: string;
    secret_ref: string;
  }[];

  for (const c of clusters) {
    const envVar = deriveTokenEnvVar(c.name);
    if (values[envVar] !== undefined && values[envVar] !== "") {
      await keychainClient.setSecret(c.secret_ref, values[envVar]);
    }
  }
  for (const e of environments) {
    const envVar = deriveConnStringEnvVar(e.name);
    if (values[envVar] !== undefined && values[envVar] !== "") {
      await keychainClient.setSecret(e.secret_ref, values[envVar]);
    }
  }
}

module.exports = {
  upsertRancherClusters,
  upsertDbEnvironments,
  applySecretValues,
  upsertNamespaceGroups,
  listNamespaceGroups,
};
