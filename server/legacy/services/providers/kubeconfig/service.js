const { AppError } = require("../../../utils/error");
const { unwrapK8sResponse } = require("../../../utils/k8s-response");

function summarizeService(item) {
  return {
    name: item.metadata?.name,
    type: item.spec?.type || "ClusterIP",
    clusterIP: item.spec?.clusterIP || null,
    ports: (item.spec?.ports || []).map((port) => ({
      port: port.port,
      targetPort: port.targetPort,
      protocol: port.protocol
    })),
    createdAt: item.metadata?.creationTimestamp || null
  };
}

async function listServices(ctx) {
  const response = await ctx.coreV1.listNamespacedService({ namespace: ctx.namespace });
  const list = unwrapK8sResponse(response);
  return (list.items || []).map(summarizeService);
}

async function describeService(ctx, serviceName) {
  try {
    const response = await ctx.coreV1.readNamespacedService({
      name: serviceName,
      namespace: ctx.namespace
    });
    return unwrapK8sResponse(response);
  } catch (error) {
    throw new AppError(error.body?.message || `Service not found: ${serviceName}`, Number(error.statusCode) || 404);
  }
}

async function deleteService(ctx, serviceName) {
  try {
    await ctx.coreV1.deleteNamespacedService({ name: serviceName, namespace: ctx.namespace });
    return { message: `Service deleted: ${serviceName}` };
  } catch (error) {
    throw new AppError(error.body?.message || `Failed to delete service: ${serviceName}`, Number(error.statusCode) || 400);
  }
}

module.exports = {
  listServices,
  describeService,
  deleteService
};
