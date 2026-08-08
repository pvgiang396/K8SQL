const { createKubeContextByDomain, buildRancherContext, buildRancherContextAdhoc } = require("./kube.service");
const { getEnvironmentOrThrow } = require("./db-environment.service");
const { AppError } = require("../utils/error");
const { logOperation } = require("../utils/logger");
const kubeconfigPod = require("./providers/kubeconfig/pod");
const rancherPod = require("./providers/rancher/pod");

function implFor(ctx) {
  return ctx.provider === "rancher" ? rancherPod : kubeconfigPod;
}

async function listPods(domain) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).listPods(ctx);
    logOperation({ ...ctx, resource: "pod", operation: "list", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "pod", operation: "list", success: false, error: error.message });
    throw error;
  }
}

// listPodsForDbEnv — phục vụ dropdown "Pod có sẵn" ở Settings cho entry db-environments.json kiểu
// "tự đủ" (rancherKey/namespace/projectId) — cùng cách dựng ctx với
// dbtunnel.service.js::openTunnelForDbEnv(). Chỉ hỗ trợ provider Rancher, khớp giới hạn hiện có
// của openTunnelForDbEnv (chưa có dbEnv "tự đủ" nào dùng provider kubeconfig).
async function listPodsForDbEnv(dbEnvName) {
  const dbEnv = getEnvironmentOrThrow(dbEnvName);
  if (!dbEnv.rancherKey || !dbEnv.namespace || !dbEnv.projectId) {
    throw new AppError(
      `Environment "${dbEnvName}" chưa khai đủ rancherKey/namespace/projectId — cần điền xong các trường này trước khi chọn "Pod có sẵn".`,
      400
    );
  }
  const ctx = await buildRancherContext({
    domain: `db-env:${dbEnv.name}`,
    clusterName: dbEnv.rancherKey,
    rancherCluster: dbEnv.rancherKey,
    namespace: dbEnv.namespace,
    projectId: dbEnv.projectId
  });
  try {
    const data = await implFor(ctx).listPods(ctx);
    logOperation({ ...ctx, resource: "pod", operation: "list-for-db-env", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "pod", operation: "list-for-db-env", success: false, error: error.message });
    throw error;
  }
}

// listPodsForDbEnvAdhoc — như listPodsForDbEnv() nhưng phục vụ entry Connection String CHƯA "Áp
// dụng" (isNew) ở Settings UI — không đọc config/db-environments.json, dùng thẳng
// namespace/projectId + (rancherKey đã lưu HOẶC rancherUrl/token/clusterId gõ tay chưa lưu) do
// frontend gửi lên. Xem public/shared/settings-modal.js::fetchPodOptions().
async function listPodsForDbEnvAdhoc({ rancherKey, namespace, projectId, rancherUrl, token, clusterId, insecureTLS }) {
  if (!namespace || !projectId) {
    throw new AppError('Thiếu "namespace"/"projectId" để liệt kê pod.', 400);
  }
  const domainLabel = `db-env-adhoc:${rancherKey || clusterId || "adhoc"}:${namespace}`;
  const ctx = rancherKey
    ? await buildRancherContext({
        domain: domainLabel,
        clusterName: rancherKey,
        rancherCluster: rancherKey,
        namespace,
        projectId
      })
    : await buildRancherContextAdhoc({ domain: domainLabel, namespace, projectId, rancherUrl, token, clusterId, insecureTLS });
  try {
    const data = await implFor(ctx).listPods(ctx);
    logOperation({ ...ctx, resource: "pod", operation: "list-for-db-env-adhoc", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "pod", operation: "list-for-db-env-adhoc", success: false, error: error.message });
    throw error;
  }
}

async function describePod(domain, podName) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).describePod(ctx, podName);
    logOperation({ ...ctx, resource: "pod", operation: "describe", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "pod", operation: "describe", success: false, error: error.message });
    throw error;
  }
}

async function deletePod(domain, podName) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).deletePod(ctx, podName);
    logOperation({ ...ctx, resource: "pod", operation: "delete", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "pod", operation: "delete", success: false, error: error.message });
    throw error;
  }
}

async function restartPod(domain, podName) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).restartPod(ctx, podName);
    logOperation({ ...ctx, resource: "pod", operation: "restart", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "pod", operation: "restart", success: false, error: error.message });
    throw error;
  }
}

async function getPodStatus(domain, podName) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).getPodStatus(ctx, podName);
    logOperation({ ...ctx, resource: "pod", operation: "status", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "pod", operation: "status", success: false, error: error.message });
    throw error;
  }
}

module.exports = {
  listPods,
  listPodsForDbEnv,
  listPodsForDbEnvAdhoc,
  describePod,
  deletePod,
  restartPod,
  getPodStatus
};
