const yaml = require("js-yaml");
const { createKubeContextByDomain } = require("./kube.service");
const { logOperation } = require("../utils/logger");
const kubeconfigService = require("./providers/kubeconfig/service");
const rancherService = require("./providers/rancher/service");

function implFor(ctx) {
  return ctx.provider === "rancher" ? rancherService : kubeconfigService;
}

async function listServices(domain) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).listServices(ctx);
    logOperation({ ...ctx, resource: "service", operation: "list", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "service", operation: "list", success: false, error: error.message });
    throw error;
  }
}

async function describeService(domain, serviceName) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).describeService(ctx, serviceName);
    logOperation({ ...ctx, resource: "service", operation: "describe", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "service", operation: "describe", success: false, error: error.message });
    throw error;
  }
}

async function getServiceYaml(domain, serviceName) {
  const service = await describeService(domain, serviceName);
  return yaml.dump(service, { noRefs: true, lineWidth: -1 });
}

async function deleteService(domain, serviceName) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).deleteService(ctx, serviceName);
    logOperation({ ...ctx, resource: "service", operation: "delete", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "service", operation: "delete", success: false, error: error.message });
    throw error;
  }
}

module.exports = {
  listServices,
  describeService,
  getServiceYaml,
  deleteService
};
