const fs = require("fs/promises");
const path = require("path");
const { AppError } = require("../utils/error");
const rancherClient = require("./rancher.client");

const namespacesConfigPath = path.resolve(__dirname, "..", "config", "namespaces.json");
let k8sModulePromise;

async function getK8sModule() {
  if (!k8sModulePromise) {
    k8sModulePromise = import("@kubernetes/client-node").then((moduleValue) => moduleValue.default || moduleValue);
  }
  return k8sModulePromise;
}

// Chấp nhận cả "domain.com" lẫn "https://domain.com" trỏ cùng 1 entry — namespaces.json lưu domains
// dạng URL đầy đủ (https://...), nhưng caller (vd index.js --deploy) hay truyền domain trần không scheme.
function normalizeDomain(domain) {
  return String(domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

// entry.domains chấp nhận cả string cũ lẫn object mới { url, env } — không phá vỡ config chưa migrate.
function domainUrl(candidate) {
  return typeof candidate === "string" ? candidate : candidate?.url;
}

function getDomainEnv(entry, domain) {
  const target = normalizeDomain(domain);
  const match = (entry.domains || []).find((candidate) => normalizeDomain(domainUrl(candidate)) === target);
  return typeof match === "object" ? match?.env : undefined;
}

async function readNamespacesConfig() {
  const raw = await fs.readFile(namespacesConfigPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new AppError("config/namespaces.json must be an array.", 500);
  }
  return parsed;
}

function resolveConfigPath(configPath) {
  if (!configPath) {
    throw new AppError("Missing configPath in namespaces.json entry.", 500);
  }
  if (path.isAbsolute(configPath)) {
    return configPath;
  }
  return path.resolve(__dirname, "..", configPath);
}

function findClusterByDomain(items, domain) {
  const target = normalizeDomain(domain);
  return items.find((item) => Array.isArray(item.domains) && item.domains.some((candidate) => normalizeDomain(domainUrl(candidate)) === target));
}

async function createKubeconfigContext(domain, cluster) {
  const kubeconfigFilePath = resolveConfigPath(cluster.configPath);

  try {
    await fs.access(kubeconfigFilePath);
  } catch {
    throw new AppError("Unable to connect to Kubernetes cluster.", 502, {
      reason: "kubeconfig file not found",
      kubeconfigFilePath
    });
  }

  try {
    const k8s = await getK8sModule();
    const kc = new k8s.KubeConfig();
    kc.loadFromFile(kubeconfigFilePath);

    const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
    await coreV1.readNamespace({ name: cluster.namespace });

    return {
      provider: "kubeconfig",
      domain,
      clusterName: cluster.name,
      namespace: cluster.namespace,
      kubeconfigFilePath,
      appsV1: kc.makeApiClient(k8s.AppsV1Api),
      coreV1,
      networkingV1: kc.makeApiClient(k8s.NetworkingV1Api),
      authorizationV1: kc.makeApiClient(k8s.AuthorizationV1Api),
      kc
    };
  } catch (error) {
    throw new AppError("Unable to connect to Kubernetes cluster.", 502, {
      reason: error.body?.message || error.message || "authentication failed or cluster unreachable"
    });
  }
}

// Dùng chung bởi createRancherContext (theo domain, qua namespaces.json) VÀ
// dbtunnel.service.js::openTunnelForDbEnv (theo db-environments.json tự đủ, không cần
// namespaces.json) — cả 2 chỉ khác nguồn lấy rancherCluster/projectId/namespace, phần dựng ctx +
// verify quyền project giống hệt nhau.
async function buildRancherContext({ domain, clusterName, rancherCluster, namespace, projectId }) {
  if (!rancherCluster) {
    throw new AppError(`Missing rancherCluster for: ${domain}`, 500);
  }
  if (!projectId) {
    throw new AppError(`Missing projectId for: ${domain}`, 500);
  }

  const rancherCtx = await rancherClient.resolveRancherCluster(rancherCluster);

  const ctx = {
    provider: "rancher",
    domain,
    clusterName: clusterName || rancherCluster,
    namespace,
    rancherUrl: rancherCtx.rancherUrl,
    insecureTLS: rancherCtx.insecureTLS,
    token: rancherCtx.token,
    clusterId: rancherCtx.clusterId,
    projectId
  };

  try {
    await rancherClient.verifyProjectAccess(ctx);
  } catch (error) {
    throw new AppError("Unable to connect to Kubernetes cluster.", 502, {
      reason: error.message || "Rancher authentication failed or project unreachable"
    });
  }

  return ctx;
}

// buildRancherContextAdhoc — như buildRancherContext() nhưng dựng ctx THẲNG từ rancherUrl/token/
// clusterId truyền vào (KHÔNG đọc config/rancher-clusters.json/.env qua rancherClient.resolveRancherCluster()).
// Dùng khi cluster CHƯA "Áp dụng" (chưa lưu) — cùng tinh thần rancherClient.buildAdhocCtx() (dùng cho
// 3 hàm "browse" project/namespace/service) nhưng cho nhánh cần projectId + verify quyền thật (pod
// listing/db tunnel ad-hoc ở Settings UI, xem services/pod.service.js::listPodsForDbEnvAdhoc()).
async function buildRancherContextAdhoc({ domain, namespace, projectId, rancherUrl, token, clusterId, insecureTLS }) {
  if (!rancherUrl || !token || !clusterId) {
    throw new AppError('Thiếu "rancherUrl"/"token"/"clusterId" để dò ad-hoc.', 400);
  }
  if (!projectId) {
    throw new AppError(`Missing projectId for: ${domain}`, 500);
  }

  const ctx = {
    provider: "rancher",
    domain,
    clusterName: clusterId,
    namespace,
    rancherUrl: String(rancherUrl).replace(/\/+$/, ""),
    insecureTLS: Boolean(insecureTLS),
    token,
    clusterId,
    projectId
  };

  try {
    await rancherClient.verifyProjectAccess(ctx);
  } catch (error) {
    throw new AppError("Unable to connect to Kubernetes cluster.", 502, {
      reason: error.message || "Rancher authentication failed or project unreachable"
    });
  }

  return ctx;
}

async function createRancherContext(domain, cluster) {
  if (!cluster.rancherCluster) {
    throw new AppError(`Missing rancherCluster in namespaces.json entry for domain: ${domain}`, 500);
  }
  if (!cluster.projectId) {
    throw new AppError(`Missing projectId in namespaces.json entry for domain: ${domain}`, 500);
  }

  return buildRancherContext({
    domain,
    clusterName: cluster.name,
    rancherCluster: cluster.rancherCluster,
    namespace: cluster.namespace,
    projectId: cluster.projectId
  });
}

async function getGroupEntryByDomain(domain) {
  const namespaceConfigs = await readNamespacesConfig();
  const cluster = findClusterByDomain(namespaceConfigs, domain);

  if (!cluster) {
    throw new AppError(`Domain is not mapped in namespaces.json: ${domain}`, 404);
  }

  return cluster;
}

async function createKubeContextByDomain(domain) {
  const cluster = await getGroupEntryByDomain(domain);

  if (!cluster.namespace) {
    throw new AppError(`Namespace is missing for domain mapping: ${domain}`, 500);
  }

  const provider = cluster.provider || "kubeconfig";

  if (provider === "rancher") {
    return createRancherContext(domain, cluster);
  }

  if (provider === "kubeconfig") {
    return createKubeconfigContext(domain, cluster);
  }

  throw new AppError(`Unknown provider in namespaces.json entry: ${provider}`, 500);
}

module.exports = {
  createKubeContextByDomain,
  buildRancherContext,
  buildRancherContextAdhoc,
  readNamespacesConfig,
  getGroupEntryByDomain,
  domainUrl,
  getDomainEnv,
  normalizeDomain
};
