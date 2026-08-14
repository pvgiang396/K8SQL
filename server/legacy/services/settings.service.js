"use strict";

const fs = require("fs");
const path = require("path");
const { AppError } = require("../utils/error");
const { logOperation } = require("../utils/logger");
const { browseDirectoryNative } = require("../scripts/lib/browse-directory");
const { readEnvFile, dbEnvVarNames } = require("../scripts/lib/config-info");
const rancherClient = require("./rancher.client");
const { getBaseDir } = require("../utils/base-dir");
const settingsRepo = require("../../src/config/repository/settingsRepo.ts");
const { materializeLegacyConfig } = require("../../src/secrets/envShim.ts");

const ROOT_DIR = getBaseDir();
const RANCHER_CLUSTERS_PATH = path.join(ROOT_DIR, "config", "rancher-clusters.json");
const DB_ENVIRONMENTS_PATH = path.join(ROOT_DIR, "config", "db-environments.json");

// Trả ĐÚNG CÙNG 1 bộ thông tin mà wizard cài đặt gốc (scripts/wizard.js's /current-config) hiển
// thị — modal "Cấu hình" trong GUI đang chạy phải giống hệt màn hình lúc chạy quickstart, không chỉ
// mỗi thư mục cài đặt. KHÔNG trả giá trị thật của token/connection string qua API (chỉ biết đã có
// hay chưa) — cùng lý do bảo mật đã áp dụng cho wizard.js.
function getCurrentInstallInfo() {
  const env = readEnvFile(ROOT_DIR);
  return {
    installDir: ROOT_DIR,
    port: env.PORT || "3210",
    rancherOperatorTokenSet: Boolean(env.R3_RANCHER_OPERATOR_TOKEN),
    idgPlatformRancherTokenSet: Boolean(env.IDG_PLATFORM_RANCHER_TOKEN),
    dbEnvVars: dbEnvVarNames(ROOT_DIR).map((name) => ({ name, hasValue: Boolean(env[name]) }))
  };
}

// k8sql: KHÔNG relocate install dir (Tauri không hỗ trợ, xem CLAUDE.md mục "Việc KHÔNG port") —
// applySettings() giờ chỉ còn việc ghi giá trị secret thật (`values`, map {<tokenEnvVar hoặc
// connectionStringEnvVar đã derive>: <giá trị thật>}) vào keychain qua
// settingsRepo.applySecretValues(), rồi materialize lại config/.env NGAY trong cùng tiến trình
// (không cần spawn script/restart service như k8sctl gốc — SQLite+keychain không cần "tạo lại
// service" để đọc giá trị mới, chỉ cần ghi xong + materialize).
async function applySettings({ values }) {
  await settingsRepo.applySecretValues(values || {});
  await materializeLegacyConfig(ROOT_DIR);

  logOperation({ resource: "settings", operation: "apply", success: true });

  return { message: "Đã lưu cấu hình." };
}

function readJsonArray(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Không trả token thật qua API — chỉ metadata + hasValue (đã có giá trị trong .env hay chưa),
// cùng nguyên tắc bảo mật đã áp dụng cho dbEnvVars.
function listRancherClusters() {
  const env = readEnvFile(ROOT_DIR);
  return readJsonArray(RANCHER_CLUSTERS_PATH).map((cluster) => ({
    name: cluster.name,
    rancherUrl: cluster.rancherUrl,
    clusterId: cluster.clusterId,
    insecureTLS: Boolean(cluster.insecureTLS),
    tokenEnvVar: cluster.tokenEnvVar,
    description: cluster.description || "",
    hasValue: Boolean(env[cluster.tokenEnvVar])
  }));
}

// GHI VÀO SQLITE (settingsRepo.upsertRancherClusters) thay vì config/rancher-clusters.json trực
// tiếp — file JSON đó giờ chỉ là bản materialize TỪ SQLite (envShim.ts), ghi thẳng vào nó sẽ bị
// ghi đè mất ở lần restart/materialize kế tiếp (bug thật đã tự phát hiện, xem CLAUDE.md mục "Việc
// tồn đọng Phase 3" — đã fix bằng thay đổi này). `tokenEnvVar` phía client vẫn gửi lên (cosmetic,
// derive từ URL) nhưng không còn dùng để lưu — secret_ref SQLite tự sinh, không phụ thuộc tên biến.
async function saveRancherClusters(clusters) {
  if (!Array.isArray(clusters)) {
    throw new AppError('"clusters" phải là 1 mảng.', 400);
  }
  const names = new Set();
  const tokenEnvVars = new Set();
  for (const cluster of clusters) {
    if (!cluster || typeof cluster.name !== "string" || !cluster.name.trim()) {
      throw new AppError("Mỗi cluster phải có \"name\" (Rancher Key).", 400);
    }
    if (!cluster.rancherUrl || !cluster.clusterId || !cluster.tokenEnvVar) {
      throw new AppError(`Cluster "${cluster.name}" thiếu rancherUrl/clusterId/tokenEnvVar.`, 400);
    }
    if (names.has(cluster.name)) {
      throw new AppError(`Rancher Key trùng lặp: "${cluster.name}".`, 400);
    }
    if (tokenEnvVars.has(cluster.tokenEnvVar)) {
      throw new AppError(`tokenEnvVar trùng lặp: "${cluster.tokenEnvVar}".`, 400);
    }
    names.add(cluster.name);
    tokenEnvVars.add(cluster.tokenEnvVar);
  }

  await settingsRepo.upsertRancherClusters(clusters);
  await materializeLegacyConfig(ROOT_DIR);

  return { message: "Đã lưu danh sách Rancher cluster." };
}

// Không trả connectionStringEnvVar thật/secret — chỉ metadata + hasValue.
function listDbEnvironments() {
  const env = readEnvFile(ROOT_DIR);
  return readJsonArray(DB_ENVIRONMENTS_PATH).map((item) => ({
    name: item.name,
    description: item.description,
    connectionStringEnvVar: item.connectionStringEnvVar,
    mode: item.mode,
    domain: item.domain,
    rancherKey: item.rancherKey,
    namespace: item.namespace,
    dbHost: item.dbHost,
    dbPort: item.dbPort,
    projectId: item.projectId,
    allowWrite: Boolean(item.allowWrite),
    engine: item.engine,
    existingPodName: item.existingPodName,
    hasValue: Boolean(env[item.connectionStringEnvVar])
  }));
}

// GHI VÀO SQLITE (settingsRepo.upsertDbEnvironments) — cùng lý do saveRancherClusters() ở trên.
async function saveDbEnvironments(environments) {
  if (!Array.isArray(environments)) {
    throw new AppError('"environments" phải là 1 mảng.', 400);
  }
  const names = new Set();
  const envVars = new Set();
  for (const item of environments) {
    if (!item || typeof item.name !== "string" || !item.name.trim()) {
      throw new AppError('Mỗi connection phải có "name" (URL KEY).', 400);
    }
    if (!item.connectionStringEnvVar) {
      throw new AppError(`Connection "${item.name}" thiếu connectionStringEnvVar.`, 400);
    }
    if (names.has(item.name)) {
      throw new AppError(`URL KEY trùng lặp: "${item.name}".`, 400);
    }
    if (envVars.has(item.connectionStringEnvVar)) {
      throw new AppError(`connectionStringEnvVar trùng lặp: "${item.connectionStringEnvVar}".`, 400);
    }
    if (item.rancherKey && (!item.namespace || !item.dbHost || !item.dbPort || !item.projectId)) {
      throw new AppError(
        `Connection "${item.name}" đã chọn Rancher Key nên cần đủ namespace/dbHost/dbPort/projectId.`,
        400
      );
    }
    if (item.existingPodName && !item.rancherKey) {
      throw new AppError(
        `Connection "${item.name}" đã chọn "Pod có sẵn" nên cần đủ Rancher Key/namespace/dbHost/dbPort/projectId.`,
        400
      );
    }
    names.add(item.name);
    envVars.add(item.connectionStringEnvVar);
  }

  await settingsRepo.upsertDbEnvironments(environments);
  await materializeLegacyConfig(ROOT_DIR);

  return { message: "Đã lưu danh sách connection string." };
}

// revealRancherToken/revealDbEnvironmentValue — CHỈ 2 chỗ trong toàn bộ service này trả giá trị
// secret thật qua API (mọi hàm list* khác cố tình không bao giờ làm vậy, xem comment ở
// listRancherClusters()/listDbEnvironments()). Chấp nhận được vì: (1) chỉ gọi khi user chủ động
// bấm icon con mắt trên UI, không tự động tải sẵn hàng loạt; (2) k8sctl mặc định chỉ bind loopback
// (xem CLAUDE.md mục "Giới hạn cần biết"), không có tầng auth nào khác — đây LÀ tầng bảo vệ duy
// nhất, không expose thêm được nữa dù muốn.
function revealRancherToken(name) {
  const cluster = readJsonArray(RANCHER_CLUSTERS_PATH).find((c) => c.name === name);
  if (!cluster) {
    throw new AppError(`Không tìm thấy Rancher "${name}".`, 404);
  }
  const env = readEnvFile(ROOT_DIR);
  logOperation({ resource: "settings", operation: "reveal-rancher-token", clusterName: name, success: true });
  return { value: env[cluster.tokenEnvVar] || "" };
}

function revealDbEnvironmentValue(name) {
  const item = readJsonArray(DB_ENVIRONMENTS_PATH).find((i) => i.name === name);
  if (!item) {
    throw new AppError(`Không tìm thấy connection "${name}".`, 404);
  }
  const env = readEnvFile(ROOT_DIR);
  let value = env[item.connectionStringEnvVar] || "";
  // Mode k8s-tunnel lưu placeholder "__HOST__" thay cho host:port thật trong .env (xem
  // toTunnelConnectionTemplate() ở settings-modal.js) — chỉ có ý nghĩa lúc tunnel đang mở, không
  // phải "giá trị thật" user muốn xem khi bấm icon con mắt (bug thật đã báo: hiện nguyên
  // "__HOST__" thay vì địa chỉ DB thật). Thay lại bằng dbHost:dbPort đã lưu trên chính entry này để
  // trả về đúng connection string thật, dùng kết nối trực tiếp được (không qua tunnel).
  if (value.includes("__HOST__") && item.dbHost && item.dbPort) {
    value = value.replace("__HOST__", `${item.dbHost}:${item.dbPort}`);
  }
  logOperation({ resource: "settings", operation: "reveal-db-env-value", env: name, success: true });
  return { value };
}

function browseDirectory() {
  try {
    const chosenPath = browseDirectoryNative();
    return { path: chosenPath || null };
  } catch (error) {
    return { path: null, error: error.message };
  }
}

function assertAdhocRancher(adhoc) {
  if (!adhoc || !adhoc.rancherUrl || !adhoc.token || !adhoc.clusterId) {
    throw new AppError('Thiếu "rancherUrl"/"token"/"clusterId" để dò ad-hoc.', 400);
  }
}

// 3 hàm "browse" dưới đây gọi thẳng Rancher/k8s API THẬT (services/rancher.client.js). Có 2 nhánh:
// (1) `rancherKey` — cluster ĐÃ lưu vào config/rancher-clusters.json + có token trong .env; (2)
// `adhoc` ({rancherUrl, token, clusterId, insecureTLS}) — cluster CHƯA lưu, dùng thẳng dữ liệu vừa
// gõ trên UI (cùng tinh thần listClustersAdhoc()/rancher-cluster-options — xem
// public/shared/settings-modal.js::fetchCascade()). UI phải tự xử lý lỗi (401/500) bằng cách cho
// phép nhập tay namespace/dbHost/dbPort thay vì chặn cứng luồng khi API chưa dùng được.
async function listRancherProjects(rancherKey, adhoc) {
  if (adhoc) {
    assertAdhocRancher(adhoc);
    return rancherClient.listProjects(null, adhoc);
  }
  if (!rancherKey) {
    throw new AppError('Thiếu "rancherKey".', 400);
  }
  return rancherClient.listProjects(rancherKey);
}

async function listRancherNamespaces(rancherKey, projectId, adhoc) {
  if (!projectId) {
    throw new AppError('Thiếu "projectId".', 400);
  }
  if (adhoc) {
    assertAdhocRancher(adhoc);
    return rancherClient.listNamespaces(null, projectId, adhoc);
  }
  if (!rancherKey) {
    throw new AppError('Thiếu "rancherKey".', 400);
  }
  return rancherClient.listNamespaces(rancherKey, projectId);
}

async function listRancherServices(rancherKey, projectId, namespace, adhoc) {
  if (!projectId || !namespace) {
    throw new AppError('Thiếu "projectId"/"namespace".', 400);
  }
  if (adhoc) {
    assertAdhocRancher(adhoc);
    return rancherClient.listServices(null, projectId, namespace, adhoc);
  }
  if (!rancherKey) {
    throw new AppError('Thiếu "rancherKey".', 400);
  }
  return rancherClient.listServices(rancherKey, projectId, namespace);
}

// Deployment thật (khác listRancherServices — Service) cho combobox "Deployment" ở Nhóm Namespace,
// xem rancherClient.listDeployments(). Chỉ hỗ trợ rancherKey đã lưu (không có nhánh adhoc — Nhóm
// Namespace không hỗ trợ cluster ad-hoc, xem k8sql/CLAUDE.md mục "UI" của Nhóm namespace).
async function listRancherDeployments(rancherKey, projectId, namespace) {
  if (!rancherKey) {
    throw new AppError('Thiếu "rancherKey".', 400);
  }
  if (!projectId || !namespace) {
    throw new AppError('Thiếu "projectId"/"namespace".', 400);
  }
  return rancherClient.listDeployments(rancherKey, projectId, namespace);
}

// Dò cluster ad-hoc bằng URL+token user vừa gõ (chưa lưu vào config/rancher-clusters.json) — dùng
// để gợi ý clusterId lúc đang "Thêm mới" cluster trên settings-modal.js, khác 3 hàm "browse" ở trên
// (đọc token đã lưu qua tokenEnvVar trong .env).
async function listRancherClusterOptions({ rancherUrl, token, insecureTLS }) {
  if (!rancherUrl || !token) {
    throw new AppError('Thiếu "rancherUrl"/"token".', 400);
  }
  return rancherClient.listClustersAdhoc({ rancherUrl, token, insecureTLS });
}

// Nhóm namespace (domain→cluster/project/namespace/deployment mapping, provider "rancher") — GHI
// VÀO SQLITE (settingsRepo.upsertNamespaceGroups) rồi materialize lại config/namespaces.json, cùng
// pattern saveRancherClusters/saveDbEnvironments ở trên. Route add-group cũ (provisionService,
// ghi thẳng file) vẫn giữ lại cho tương thích API k8sctl gốc, nhưng UI/AI nên dùng route này để
// mapping sống sót qua materialize/restart.
function listNamespaceGroups() {
  return settingsRepo.listNamespaceGroups();
}

async function saveNamespaceGroups(groups) {
  if (!Array.isArray(groups)) {
    throw new AppError('"groups" phải là 1 mảng.', 400);
  }
  const names = new Set();
  for (const g of groups) {
    if (!g || typeof g.name !== "string" || !g.name.trim()) {
      throw new AppError('Mỗi nhóm phải có "name".', 400);
    }
    if (!g.namespace || typeof g.namespace !== "string") {
      throw new AppError(`Nhóm "${g.name}" thiếu "namespace".`, 400);
    }
    if (!Array.isArray(g.domains) || g.domains.length === 0) {
      throw new AppError(`Nhóm "${g.name}" phải có ít nhất 1 domain.`, 400);
    }
    const provider = g.provider || "rancher";
    if (provider === "rancher" && (!g.rancherCluster || !g.projectId)) {
      throw new AppError(`Nhóm "${g.name}" (provider rancher) thiếu "rancherCluster"/"projectId".`, 400);
    }
    if (names.has(g.name)) {
      throw new AppError(`Tên nhóm trùng lặp: "${g.name}".`, 400);
    }
    names.add(g.name);
  }

  await settingsRepo.upsertNamespaceGroups(groups);
  await materializeLegacyConfig(ROOT_DIR);

  return { message: "Đã lưu danh sách nhóm namespace." };
}

module.exports = {
  getCurrentInstallInfo,
  applySettings,
  browseDirectory,
  listRancherClusters,
  saveRancherClusters,
  revealRancherToken,
  listRancherProjects,
  listRancherNamespaces,
  listRancherServices,
  listRancherDeployments,
  listRancherClusterOptions,
  listDbEnvironments,
  saveDbEnvironments,
  revealDbEnvironmentValue,
  listNamespaceGroups,
  saveNamespaceGroups
};
