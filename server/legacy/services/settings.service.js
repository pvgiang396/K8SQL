"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { AppError } = require("../utils/error");
const { logOperation } = require("../utils/logger");
const { browseDirectoryNative } = require("../scripts/lib/browse-directory");
const { readEnvFile, dbEnvVarNames } = require("../scripts/lib/config-info");
const rancherClient = require("./rancher.client");
const { getBaseDir } = require("../utils/base-dir");

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

function assertValidInstallDir(installDir) {
  if (typeof installDir !== "string" || !installDir.trim()) {
    throw new AppError('Thiếu "installDir".', 400);
  }
  if (!path.isAbsolute(installDir)) {
    throw new AppError('"installDir" phải là đường dẫn tuyệt đối.', 400);
  }
}

// Không làm việc di chuyển/tạo lại service/ghi .env NGAY trong tiến trình Express đang chạy — spawn
// 1 tiến trình con TÁCH RỜI (detached) gọi lại logic đã có sẵn trong setup.sh (qua
// scripts/apply-settings.sh + scripts/relocate-and-recreate.sh + scripts/apply-env-values.sh), để
// tránh vòng đời của chính tiến trình đang xử lý request này (có thể tự bị restart/kill bởi chính
// thao tác "tạo lại service" nó gọi) làm hỏng response đang gửi dở. Response trả về NGAY sau khi
// spawn xong — kết quả thật sự (di chuyển/ghi .env/service) xem trong logs/settings-relocate.log.
//
// `values` — cùng shape {PORT, R3_RANCHER_OPERATOR_TOKEN, IDG_PLATFORM_RANCHER_TOKEN, <DB_ENV_VAR>: ...}
// wizard.html gửi lên /apply — CHỈ chứa field user đã nhập (để trống ô nào = giữ nguyên giá trị cũ,
// xem scripts/apply-env-values.sh::apply_env_values_from_answers()). Ghi ra file JSON tạm rồi giao
// cho script con xử lý — KHÔNG tự ghi .env bằng JS ở đây để dùng lại đúng 1 logic duy nhất với
// setup.sh (tránh 2 nơi hiểu khác nhau thế nào là "để trống = giữ nguyên").
async function applySettings({ installDir, values }) {
  assertValidInstallDir(installDir);
  const newDir = path.resolve(installDir);
  const port = Number(process.env.PORT || 3210);
  const logDir = path.join(ROOT_DIR, "logs");
  fs.mkdirSync(logDir, { recursive: true });

  const runDir = path.join(ROOT_DIR, ".run");
  fs.mkdirSync(runDir, { recursive: true });
  // Tên file khác "wizard-answers.json" (dùng riêng bởi luồng quickstart/wizard cài đặt gốc) — tránh
  // 2 luồng độc lập vô tình đụng chung 1 file nếu chạy gần thời điểm nhau.
  const answersPath = path.join(runDir, "settings-answers.json");
  fs.writeFileSync(answersPath, JSON.stringify({ installDir: newDir, values: values || {} }, null, 2) + "\n");

  let child;
  if (process.platform === "win32") {
    const script = path.join(ROOT_DIR, "scripts", "apply-settings.ps1");
    child = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ROOT_DIR, newDir, String(port), answersPath],
      { detached: true, stdio: "ignore", cwd: ROOT_DIR }
    );
  } else {
    const script = path.join(ROOT_DIR, "scripts", "apply-settings.sh");
    child = spawn("bash", [script, ROOT_DIR, newDir, String(port), answersPath], {
      detached: true,
      stdio: "ignore",
      cwd: ROOT_DIR
    });
  }
  child.unref();

  logOperation({ resource: "settings", operation: "apply", success: true });

  return {
    message:
      newDir === ROOT_DIR
        ? "Đang lưu cấu hình + khởi động lại tại chỗ — vài giây nữa app sẽ sẵn sàng lại."
        : `Đang di chuyển sang "${newDir}" và khởi động lại service — vài giây nữa hãy tải lại trang.`
  };
}

function readJsonArray(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Ghi thẳng ĐỒNG BỘ (fs.writeFileSync, không qua .run/*-answers.json + detached script như
// applySettings()) — vì listRancherClusters()/loadEnvironments() (services/db-environment.service.js,
// services/rancher.client.js) đều đọc lại config/*.json TƯƠI mỗi lần gọi (không cache qua
// require()), nên không cần restart tiến trình để thấy dữ liệu mới. Cơ chế detached script CHỈ
// cần thiết cho thứ phải reload process.env (secret token/connection string) hoặc di chuyển thư
// mục cài đặt — không áp dụng cho việc ghi metadata cluster/connection (không phải secret).
function writeJsonArray(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
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

function saveRancherClusters(clusters) {
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

  writeJsonArray(
    RANCHER_CLUSTERS_PATH,
    clusters.map((cluster) => ({
      name: cluster.name,
      rancherUrl: cluster.rancherUrl,
      clusterId: cluster.clusterId,
      tokenEnvVar: cluster.tokenEnvVar,
      insecureTLS: Boolean(cluster.insecureTLS),
      description: cluster.description || ""
    }))
  );

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

function saveDbEnvironments(environments) {
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

  writeJsonArray(
    DB_ENVIRONMENTS_PATH,
    environments.map((item) => {
      const entry = {
        name: item.name,
        description: item.description || "",
        connectionStringEnvVar: item.connectionStringEnvVar,
        allowWrite: Boolean(item.allowWrite)
      };
      if (item.engine) entry.engine = item.engine;
      if (item.mode) entry.mode = item.mode;
      if (item.domain) entry.domain = item.domain;
      if (item.rancherKey) {
        entry.rancherKey = item.rancherKey;
        entry.namespace = item.namespace;
        entry.dbHost = item.dbHost;
        entry.dbPort = item.dbPort;
        entry.projectId = item.projectId;
        if (item.existingPodName) entry.existingPodName = item.existingPodName;
      }
      return entry;
    })
  );

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

// Dò cluster ad-hoc bằng URL+token user vừa gõ (chưa lưu vào config/rancher-clusters.json) — dùng
// để gợi ý clusterId lúc đang "Thêm mới" cluster trên settings-modal.js, khác 3 hàm "browse" ở trên
// (đọc token đã lưu qua tokenEnvVar trong .env).
async function listRancherClusterOptions({ rancherUrl, token, insecureTLS }) {
  if (!rancherUrl || !token) {
    throw new AppError('Thiếu "rancherUrl"/"token".', 400);
  }
  return rancherClient.listClustersAdhoc({ rancherUrl, token, insecureTLS });
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
  listRancherClusterOptions,
  listDbEnvironments,
  saveDbEnvironments,
  revealDbEnvironmentValue
};
