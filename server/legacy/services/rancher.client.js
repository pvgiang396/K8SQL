const fs = require("fs/promises");
const path = require("path");
const { getBaseDir } = require("../utils/base-dir");
// Dùng fetch CỦA CHÍNH package "undici" (không phải fetch built-in Node.js) khi truyền dispatcher
// là 1 Agent tạo từ package này — 2 undici khác major (vd Node.js bundle undici 7.x nhưng
// package.json pin "undici" 8.x) đổi tên method nội bộ của handler (onConnect/onHeaders/onData →
// onRequestStart/onResponseStart/onResponseData ở undici 7→8), trộn lẫn 2 bản gây lỗi
// "invalid onRequestStart method" (bug thật đã gặp — xem k8sctl/CLAUDE.md).
const { fetch: undiciFetch, Agent } = require("undici");
const { AppError } = require("../utils/error");

const rancherClustersConfigPath = path.resolve(getBaseDir(), "config", "rancher-clusters.json");

function getUndiciAgent(insecureTLS) {
  if (!insecureTLS) {
    return undefined;
  }
  return new Agent({ connect: { rejectUnauthorized: false } });
}

async function readRancherClustersConfig() {
  const raw = await fs.readFile(rancherClustersConfigPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new AppError("config/rancher-clusters.json must be an array.", 500);
  }
  return parsed;
}

async function resolveRancherCluster(rancherClusterName) {
  const clusters = await readRancherClustersConfig();
  const cluster = clusters.find((item) => item.name === rancherClusterName);
  if (!cluster) {
    throw new AppError(`Rancher cluster not found in rancher-clusters.json: ${rancherClusterName}`, 500);
  }

  const token = process.env[cluster.tokenEnvVar];
  if (!token) {
    throw new AppError(
      `Missing Rancher API token. Set env var ${cluster.tokenEnvVar} (create via Rancher UI > API & Keys).`,
      500
    );
  }

  return {
    rancherUrl: String(cluster.rancherUrl || "").replace(/\/+$/, ""),
    clusterId: cluster.clusterId,
    insecureTLS: Boolean(cluster.insecureTLS),
    token
  };
}

function projectPrefix(ctx) {
  return `/v3/project/${ctx.clusterId}:${ctx.projectId}`;
}

// Proxy path Rancher expose để gọi thẳng raw k8s API của 1 cluster qua chính Rancher host
// (khác /v3/project/... là Norman API tầng project) — dùng cho sub-resource không có ở Norman
// API, vd log pod (xem services/providers/rancher/log.js).
function clusterProxyPrefix(ctx) {
  return `/k8s/clusters/${ctx.clusterId}`;
}

async function rancherRequest(ctx, { method = "GET", path: apiPath, body, responseType = "json" } = {}) {
  const url = `${ctx.rancherUrl}${apiPath}`;
  const agent = getUndiciAgent(ctx.insecureTLS);

  let response;
  try {
    response = await undiciFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        "Content-Type": "application/json"
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...(agent ? { dispatcher: agent } : {})
    });
  } catch (error) {
    throw new AppError("Unable to connect to Rancher API.", 502, {
      reason: error.message || "network error"
    });
  }

  if (response.status === 401 || response.status === 403) {
    throw new AppError(
      "Rancher API token invalid/expired or missing project permission.",
      response.status
    );
  }

  if (!response.ok) {
    let message = `Rancher API request failed: ${method} ${apiPath}`;
    try {
      const errorBody = await response.json();
      message = errorBody.message || message;
    } catch {
      // response body not JSON, keep default message
    }
    throw new AppError(message, response.status);
  }

  if (response.status === 204) {
    return null;
  }

  return responseType === "text" ? response.text() : response.json();
}

async function verifyProjectAccess(ctx) {
  await rancherRequest(ctx, { path: `${projectPrefix(ctx)}` });
}

// Dò danh sách cluster THẬT trực tiếp bằng URL+token user vừa gõ trên UI — KHÔNG qua
// resolveRancherCluster()/buildClusterOnlyCtx() (2 hàm đó đọc config/rancher-clusters.json +
// tokenEnvVar trong .env, chỉ dùng được cho cluster ĐÃ lưu). Dùng để gợi ý `clusterId` ngay lúc
// đang thêm cluster mới trên settings-modal.js, trước khi "Áp dụng". `/v3/clusters` là Norman API
// cluster-level, không cần ctx.clusterId (chỉ project/service-scoped API mới cần).
async function listClustersAdhoc({ rancherUrl, token, insecureTLS }) {
  const ctx = {
    rancherUrl: String(rancherUrl || "").replace(/\/+$/, ""),
    insecureTLS: Boolean(insecureTLS),
    token
  };
  const res = await rancherRequest(ctx, { path: "/v3/clusters" });
  return (res.data || []).map((c) => ({ id: c.id, name: c.name || c.id }));
}

// Dùng cho 3 hàm "browse" dưới đây — ctx CHƯA biết namespace/projectId (khác createRancherContext
// ở kube.service.js, dùng để verify quyền TRÊN 1 project cụ thể đã biết trước). Ở đây mục đích
// ngược lại: liệt kê project/namespace/service THẬT để UI dựng dropdown thay vì bắt gõ tay ID thô
// (xem public/shared/settings-modal.js — cascading Rancher Key → Project → Namespace → Service).
async function buildClusterOnlyCtx(rancherClusterName) {
  const rancherCtx = await resolveRancherCluster(rancherClusterName);
  return {
    provider: "rancher",
    rancherUrl: rancherCtx.rancherUrl,
    insecureTLS: rancherCtx.insecureTLS,
    token: rancherCtx.token,
    clusterId: rancherCtx.clusterId
  };
}

// Cùng shape ctx với buildClusterOnlyCtx() nhưng dựng THẲNG từ URL/token/clusterId truyền vào —
// KHÔNG đọc config/rancher-clusters.json/.env. Cho phép 3 hàm "browse" dưới đây hoạt động ad-hoc
// với 1 Rancher vừa gõ trên UI, chưa "Áp dụng" (chưa lưu) — cùng tinh thần listClustersAdhoc().
function buildAdhocCtx({ rancherUrl, token, clusterId, insecureTLS }) {
  return {
    provider: "rancher",
    rancherUrl: String(rancherUrl || "").replace(/\/+$/, ""),
    insecureTLS: Boolean(insecureTLS),
    token,
    clusterId
  };
}

async function resolveBrowseCtx(rancherClusterName, adhoc) {
  return adhoc ? buildAdhocCtx(adhoc) : buildClusterOnlyCtx(rancherClusterName);
}

// Norman API collection endpoint — trả mọi project mà token đang có quyền, lọc theo clusterId.
// `id` trả về dạng "<clusterId>:<projectShortId>" — chỉ lấy phần sau dấu ":" vì
// createRancherContext()/projectPrefix() ở kube.service.js tự nối lại clusterId khi dùng.
// `adhoc` (optional) — xem buildAdhocCtx(): dùng khi rancherClusterName chưa lưu vào config.
async function listProjects(rancherClusterName, adhoc) {
  const ctx = await resolveBrowseCtx(rancherClusterName, adhoc);
  const res = await rancherRequest(ctx, { path: `/v3/projects?clusterId=${encodeURIComponent(ctx.clusterId)}` });
  return (res.data || []).map((p) => {
    const shortId = String(p.id || "").includes(":") ? p.id.split(":")[1] : p.id;
    return { id: shortId, name: p.name || shortId };
  });
}

// KHÔNG có schema Norman "namespace" độc lập trên nhiều bản Rancher (đã verify thật: cả
// `/v3/namespaces`/`/v3/namespace` đều trả 404 "failed to find schema") — và raw k8s API qua
// cluster proxy (`/api/v1/namespaces`, liệt kê TOÀN CLUSTER) bị 403 vì token Rancher thường chỉ có
// quyền project-scoped, không có quyền list namespace ở cluster scope (đã verify thật). Namespace
// chỉ VIẾT ĐÚNG RBAC khi lấy gián tiếp qua 1 collection project-scoped đã biết chắc chắn tồn tại —
// dùng "services" (đằng nào cũng cần cho listServices() bên dưới, mỗi Service có field
// `namespaceId`) để suy ra danh sách namespace duy nhất. Đánh đổi: chỉ liệt kê được namespace nào
// có ÍT NHẤT 1 Service — chấp nhận được vì mục đích là gợi ý namespace phục vụ DB Tunnel (namespace
// không có Service nào thì cũng không có gì để "DB Host" trỏ tới), vẫn cho nhập tay nếu thiếu.
async function fetchProjectServices(ctx, projectId) {
  const res = await rancherRequest(ctx, {
    path: `/v3/projects/${encodeURIComponent(`${ctx.clusterId}:${projectId}`)}/services`
  });
  return res.data || [];
}

async function listNamespaces(rancherClusterName, projectId, adhoc) {
  const ctx = await resolveBrowseCtx(rancherClusterName, adhoc);
  const services = await fetchProjectServices(ctx, projectId);
  return [...new Set(services.map((svc) => svc.namespaceId).filter(Boolean))].sort();
}

// Liệt kê Service thật trong 1 namespace — UI dùng để GỢI Ý dbHost/dbPort (DNS nội bộ
// "<service>.<namespace>.svc.cluster.local" + port khai trong Service spec), không ép buộc vì DB
// thật có thể không theo đúng convention này (proxy qua LoadBalancer, port khác...) — vẫn cho sửa
// tay sau khi chọn gợi ý.
async function listServices(rancherClusterName, projectId, namespace, adhoc) {
  const ctx = await resolveBrowseCtx(rancherClusterName, adhoc);
  const services = await fetchProjectServices(ctx, projectId);
  return services
    .filter((svc) => svc.namespaceId === namespace)
    .map((svc) => ({
      name: svc.name,
      dbHost: `${svc.name}.${namespace}.svc.cluster.local`,
      ports: (svc.ports || []).map((p) => p.port).filter(Boolean)
    }));
}

module.exports = {
  resolveRancherCluster,
  rancherRequest,
  projectPrefix,
  clusterProxyPrefix,
  verifyProjectAccess,
  listProjects,
  listNamespaces,
  listServices,
  listClustersAdhoc
};
