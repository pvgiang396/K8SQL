"use strict";

const { createKubeContextByDomain } = require("./kube.service");
const { logOperation } = require("../utils/logger");
const kubeconfigPermissions = require("./providers/kubeconfig/permissions");
const rancherPermissions = require("./providers/rancher/permissions");

// 2 verb đúng những gì DB Tunnel cần (tạo + xoá jump pod) — xem services/dbtunnel.service.js.
const DB_TUNNEL_CHECKS = [
  { key: "createPods", verb: "create", resource: "pods" },
  { key: "deletePods", verb: "delete", resource: "pods" }
];

// Nhánh dùng pod có sẵn (dbEnv.existingPodName) — chỉ cần quyền exec vào pod, không tạo/xoá pod
// nào. Xem services/dbtunnel.service.js::openTunnelForDbEnv() nhánh existingPodName +
// services/providers/dbtunnel-core.js::openTunnelViaExec().
const EXEC_TUNNEL_CHECKS = [
  { key: "createPodsExec", verb: "create", resource: "pods", subresource: "exec" }
];

function implFor(ctx) {
  return ctx.provider === "rancher" ? rancherPermissions : kubeconfigPermissions;
}

// checkAccessForCtx — tách từ checkAccess để dbtunnel.service.js::openTunnelForDbEnv có thể dò
// quyền trên 1 ctx đã tự dựng sẵn (rancherKey/projectId/namespace tự đủ từ db-environments.json),
// không cần resolve lại qua domain/namespaces.json.
async function checkAccessForCtx(ctx, checks = DB_TUNNEL_CHECKS) {
  const impl = implFor(ctx);

  try {
    const results = {};
    for (const check of checks) {
      results[check.key] = await impl.checkVerb(ctx, {
        namespace: ctx.namespace,
        verb: check.verb,
        resource: check.resource,
        subresource: check.subresource
      });
    }
    const writeAccess = Object.values(results).every(Boolean);
    logOperation({ ...ctx, resource: "permissions", operation: "check", success: true });
    return { namespace: ctx.namespace, checks: results, writeAccess };
  } catch (error) {
    logOperation({ ...ctx, resource: "permissions", operation: "check", success: false, error: error.message });
    throw error;
  }
}

async function checkAccess(domain, checks = DB_TUNNEL_CHECKS) {
  const ctx = await createKubeContextByDomain(domain);
  return checkAccessForCtx(ctx, checks);
}

module.exports = { checkAccess, checkAccessForCtx, DB_TUNNEL_CHECKS, EXEC_TUNNEL_CHECKS };
