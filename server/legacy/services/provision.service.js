'use strict';

const fs = require("fs/promises");
const path = require("path");
const { AppError } = require("../utils/error");
const { logOperation } = require("../utils/logger");
const rancherClient = require("./rancher.client");
const rancherProvision = require("./providers/rancher/provision");
const kubeconfigProvision = require("./providers/kubeconfig/provision");
const { getBaseDir } = require("../utils/base-dir");

const namespacesConfigPath = path.resolve(getBaseDir(), "config", "namespaces.json");

// ─── applyYaml ────────────────────────────────────────────────────────────────
// Tạo context trực tiếp từ tham số đầu vào (không qua domain lookup) vì site
// chưa có trong namespaces.json khi đang provisioning.

async function buildRancherProvisionCtx(rancherClusterName, namespace) {
  const clusterInfo = await rancherClient.resolveRancherCluster(rancherClusterName);
  return {
    provider: "rancher",
    clusterName: rancherClusterName,
    namespace,
    rancherUrl: clusterInfo.rancherUrl,
    insecureTLS: clusterInfo.insecureTLS,
    token: clusterInfo.token,
    clusterId: clusterInfo.clusterId
  };
}

async function buildKubeconfigProvisionCtx(configPath, namespace) {
  const { default: k8s } = await import("@kubernetes/client-node");
  const resolved = path.isAbsolute(configPath)
    ? configPath
    : path.resolve(getBaseDir(), configPath);

  try {
    await fs.access(resolved);
  } catch {
    throw new AppError("kubeconfig file not found.", 400, { configPath: resolved });
  }

  const kc = new k8s.KubeConfig();
  kc.loadFromFile(resolved);

  return {
    provider: "kubeconfig",
    clusterName: resolved,
    namespace,
    coreV1: kc.makeApiClient(k8s.CoreV1Api),
    appsV1: kc.makeApiClient(k8s.AppsV1Api),
    networkingV1: kc.makeApiClient(k8s.NetworkingV1Api)
  };
}

async function applyYaml({ rancherCluster, configPath, namespace, yaml: yamlContent }) {
  if (!namespace) throw new AppError("Thiếu tham số namespace.", 400);
  if (!yamlContent) throw new AppError("Thiếu tham số yaml.", 400);

  const isRancher = Boolean(rancherCluster);
  const isKubeconfig = Boolean(configPath);

  if (!isRancher && !isKubeconfig) {
    throw new AppError("Phải truyền rancherCluster (rancher) hoặc configPath (kubeconfig).", 400);
  }

  const ctx = isRancher
    ? await buildRancherProvisionCtx(rancherCluster, namespace)
    : await buildKubeconfigProvisionCtx(configPath, namespace);

  const impl = ctx.provider === "rancher" ? rancherProvision : kubeconfigProvision;

  try {
    const result = await impl.applyYaml(ctx, yamlContent);
    logOperation({ ...ctx, resource: result.kind, operation: `provision-apply-${result.action}`, success: true });
    return result;
  } catch (error) {
    logOperation({ ...ctx, resource: "yaml", operation: "provision-apply", success: false, error: error.message });
    throw error;
  }
}

// ─── addGroup ─────────────────────────────────────────────────────────────────
// Thêm 1 entry mới vào config/namespaces.json và lưu lại file.
// Sau khi add, mọi endpoint dùng domain lookup (/resolve, /diagnose, --deploy...)
// hoạt động ngay mà không cần restart k8sctl.

async function addGroup({ name, provider, rancherCluster, projectId, configPath, namespace, domains, services }) {
  if (!name) throw new AppError("Thiếu tham số name.", 400);
  if (!namespace) throw new AppError("Thiếu tham số namespace.", 400);
  if (!domains || !Array.isArray(domains) || domains.length === 0) {
    throw new AppError("Tham số domains phải là mảng không rỗng.", 400);
  }

  const raw = await fs.readFile(namespacesConfigPath, "utf8");
  const groups = JSON.parse(raw);
  if (!Array.isArray(groups)) {
    throw new AppError("config/namespaces.json phải là mảng.", 500);
  }

  if (groups.some((g) => g.name === name)) {
    throw new AppError(`Nhóm "${name}" đã tồn tại trong namespaces.json.`, 409);
  }

  const entry = { name, provider: provider || "rancher", namespace, domains };

  if ((provider || "rancher") === "rancher") {
    if (!rancherCluster) throw new AppError("Thiếu rancherCluster cho provider rancher.", 400);
    if (!projectId) throw new AppError("Thiếu projectId cho provider rancher.", 400);
    entry.rancherCluster = rancherCluster;
    entry.projectId = projectId;
  } else {
    if (!configPath) throw new AppError("Thiếu configPath cho provider kubeconfig.", 400);
    entry.configPath = configPath;
  }

  if (services && typeof services === "object") {
    entry.services = services;
  }

  groups.push(entry);
  await fs.writeFile(namespacesConfigPath, JSON.stringify(groups, null, 2) + "\n", "utf8");

  logOperation({ clusterName: rancherCluster || configPath, namespace, resource: "group", operation: "add-group", success: true });
  return { message: `Nhóm "${name}" đã được thêm vào namespaces.json.`, entry };
}

// ─── readiness ────────────────────────────────────────────────────────────────
// Kiểm tra các deployment khai trong services map đã Available chưa.
// Domain phải đã được add-group trước — dùng domain lookup bình thường.

async function readiness(domain) {
  if (!domain) throw new AppError("Thiếu tham số domain.", 400);

  const { createKubeContextByDomain, getGroupEntryByDomain } = require("./kube.service");
  const group = await getGroupEntryByDomain(domain);
  const ctx = await createKubeContextByDomain(domain);

  const servicesMap = group.services || {};
  const serviceKeys = Object.keys(servicesMap);

  if (serviceKeys.length === 0) {
    throw new AppError("Nhóm chưa khai services map trong namespaces.json — không thể kiểm tra readiness.", 400);
  }

  const deploymentService = require("./deployment.service");
  const allDeployments = await deploymentService.listDeployments(domain);
  const byName = Object.fromEntries(allDeployments.map((d) => [d.name, d]));

  const serviceStatus = {};
  let allReady = true;

  for (const key of serviceKeys) {
    const deploymentName = servicesMap[key]?.deployment;
    if (!deploymentName) continue;

    const dep = byName[deploymentName];
    if (!dep) {
      serviceStatus[key] = { ready: false, reason: "Deployment không tìm thấy", deploymentName };
      allReady = false;
      continue;
    }

    const ready = dep.availableReplicas > 0 && dep.availableReplicas >= dep.replicas;
    if (!ready) allReady = false;
    serviceStatus[key] = { ready, replicas: dep.replicas, availableReplicas: dep.availableReplicas, deploymentName };
  }

  logOperation({ ...ctx, resource: "deployment", operation: "readiness", success: true });
  return { ready: allReady, domain, services: serviceStatus };
}

module.exports = { applyYaml, addGroup, readiness };
