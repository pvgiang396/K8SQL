const { createKubeContextByDomain } = require("./kube.service");
const { logOperation } = require("../utils/logger");
const kubeconfigLog = require("./providers/kubeconfig/log");
const rancherLog = require("./providers/rancher/log");

function implFor(ctx) {
  return ctx.provider === "rancher" ? rancherLog : kubeconfigLog;
}

async function searchLogs(options) {
  const { domain } = options;
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).searchLogs(ctx, options);
    logOperation({ ...ctx, resource: "log", operation: "search", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "log", operation: "search", success: false, error: error.message });
    throw error;
  }
}

module.exports = {
  searchLogs
};
