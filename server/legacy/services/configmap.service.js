const { createKubeContextByDomain } = require("./kube.service");
const { logOperation } = require("../utils/logger");
const kubeconfigConfigmap = require("./providers/kubeconfig/configmap");
const rancherConfigmap = require("./providers/rancher/configmap");

function implFor(ctx) {
  return ctx.provider === "rancher" ? rancherConfigmap : kubeconfigConfigmap;
}

async function readConfigMap(domain, configMapName) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).readConfigMap(ctx, configMapName);
    logOperation({ ...ctx, resource: "configmap", operation: "read", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "configmap", operation: "read", success: false, error: error.message });
    throw error;
  }
}

async function getConfigMapYaml(domain, configMapName) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).getConfigMapYaml(ctx, configMapName);
    logOperation({ ...ctx, resource: "configmap", operation: "yaml", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "configmap", operation: "yaml", success: false, error: error.message });
    throw error;
  }
}

async function updateConfigMapKey(domain, configMapName, key, value) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).updateConfigMapKey(ctx, configMapName, key, value);
    logOperation({ ...ctx, resource: "configmap", operation: "update-key", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "configmap", operation: "update-key", success: false, error: error.message });
    throw error;
  }
}

async function deleteConfigMap(domain, configMapName) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).deleteConfigMap(ctx, configMapName);
    logOperation({ ...ctx, resource: "configmap", operation: "delete", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "configmap", operation: "delete", success: false, error: error.message });
    throw error;
  }
}

module.exports = {
  readConfigMap,
  getConfigMapYaml,
  updateConfigMapKey,
  deleteConfigMap
};
