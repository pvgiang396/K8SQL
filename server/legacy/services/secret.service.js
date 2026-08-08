const { createKubeContextByDomain } = require("./kube.service");
const { logOperation } = require("../utils/logger");
const kubeconfigSecret = require("./providers/kubeconfig/secret");
const rancherSecret = require("./providers/rancher/secret");

function implFor(ctx) {
  return ctx.provider === "rancher" ? rancherSecret : kubeconfigSecret;
}

async function readSecret(domain, secretName) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).readSecret(ctx, secretName);
    logOperation({ ...ctx, resource: "secret", operation: "read", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "secret", operation: "read", success: false, error: error.message });
    throw error;
  }
}

async function getSecretYaml(domain, secretName) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).getSecretYaml(ctx, secretName);
    logOperation({ ...ctx, resource: "secret", operation: "yaml", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "secret", operation: "yaml", success: false, error: error.message });
    throw error;
  }
}

module.exports = {
  readSecret,
  getSecretYaml
};
