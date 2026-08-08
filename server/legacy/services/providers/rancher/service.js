const { AppError } = require("../../../utils/error");
const { rancherRequest, projectPrefix } = require("../../rancher.client");

function summarizeService(item) {
  return {
    name: item.name,
    type: item.kubernetesServiceType || "ClusterIP",
    clusterIP: item.clusterIp || null,
    ports: (item.ports || []).map((port) => ({
      port: port.port,
      targetPort: port.targetPort,
      protocol: port.protocol
    })),
    createdAt: item.created || null
  };
}

async function listServices(ctx) {
  const response = await rancherRequest(ctx, { path: `${projectPrefix(ctx)}/services?limit=-1` });
  const items = (response.data || []).filter((item) => item.namespaceId === ctx.namespace);
  return items.map(summarizeService);
}

async function describeService(ctx, serviceName) {
  const response = await rancherRequest(ctx, {
    path: `${projectPrefix(ctx)}/services/${ctx.namespace}:${serviceName}`
  });
  if (!response) {
    throw new AppError(`Service not found: ${serviceName}`, 404);
  }
  return response;
}

async function deleteService(ctx, serviceName) {
  await rancherRequest(ctx, {
    method: "DELETE",
    path: `${projectPrefix(ctx)}/services/${ctx.namespace}:${serviceName}`
  });
  return { message: `Service deleted: ${serviceName}` };
}

module.exports = {
  listServices,
  describeService,
  deleteService
};
