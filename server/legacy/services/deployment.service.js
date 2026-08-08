const { createKubeContextByDomain } = require("./kube.service");
const { logOperation } = require("../utils/logger");
const kubeconfigDeployment = require("./providers/kubeconfig/deployment");
const rancherDeployment = require("./providers/rancher/deployment");

function implFor(ctx) {
  return ctx.provider === "rancher" ? rancherDeployment : kubeconfigDeployment;
}

async function listDeployments(domain) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).listDeployments(ctx);
    logOperation({ ...ctx, resource: "deployment", operation: "list", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "deployment", operation: "list", success: false, error: error.message });
    throw error;
  }
}

async function describeDeployment(domain, deploymentName) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).describeDeployment(ctx, deploymentName);
    logOperation({ ...ctx, resource: "deployment", operation: "describe", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "deployment", operation: "describe", success: false, error: error.message });
    throw error;
  }
}

async function getDeploymentYaml(domain, deploymentName) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).getDeploymentYaml(ctx, deploymentName);
    logOperation({ ...ctx, resource: "deployment", operation: "yaml", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "deployment", operation: "yaml", success: false, error: error.message });
    throw error;
  }
}

async function restartDeployment(domain, deploymentName) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).restartDeployment(ctx, deploymentName);
    logOperation({ ...ctx, resource: "deployment", operation: "restart", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "deployment", operation: "restart", success: false, error: error.message });
    throw error;
  }
}

async function scaleDeployment(domain, deploymentName, replicas) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).scaleDeployment(ctx, deploymentName, replicas);
    logOperation({ ...ctx, resource: "deployment", operation: "scale", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "deployment", operation: "scale", success: false, error: error.message });
    throw error;
  }
}

async function setDeploymentImage(domain, deploymentName, image, containerName) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).setDeploymentImage(ctx, deploymentName, image, containerName);
    logOperation({ ...ctx, resource: "deployment", operation: "set-image", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "deployment", operation: "set-image", success: false, error: error.message });
    throw error;
  }
}

async function deleteDeployment(domain, deploymentName) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).deleteDeployment(ctx, deploymentName);
    logOperation({ ...ctx, resource: "deployment", operation: "delete", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "deployment", operation: "delete", success: false, error: error.message });
    throw error;
  }
}

module.exports = {
  listDeployments,
  describeDeployment,
  getDeploymentYaml,
  restartDeployment,
  scaleDeployment,
  setDeploymentImage,
  deleteDeployment
};
