const { AppError } = require("../../../utils/error");
const { rancherRequest, projectPrefix } = require("../../rancher.client");

function summarizePod(item) {
  const restarts = (item.containers || []).reduce(
    (total, container) => total + (container.restartCount || 0),
    0
  );
  return {
    name: item.name,
    phase: item.state || "unknown",
    nodeName: item.nodeId || null,
    podIP: item.status?.podIp || null,
    restarts,
    createdAt: item.created || null
  };
}

async function listPods(ctx) {
  const response = await rancherRequest(ctx, { path: `${projectPrefix(ctx)}/pods?limit=-1` });
  const items = (response.data || []).filter((item) => item.namespaceId === ctx.namespace);
  return items.map(summarizePod);
}

async function findRawPod(ctx, podName) {
  const response = await rancherRequest(ctx, {
    path: `${projectPrefix(ctx)}/pods/${ctx.namespace}:${podName}`
  });
  if (!response) {
    throw new AppError(`Pod not found: ${podName}`, 404);
  }
  return response;
}

async function describePod(ctx, podName) {
  try {
    return await findRawPod(ctx, podName);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(`Pod not found: ${podName}`, 404);
  }
}

async function deletePod(ctx, podName) {
  await rancherRequest(ctx, {
    method: "DELETE",
    path: `${projectPrefix(ctx)}/pods/${ctx.namespace}:${podName}`
  });
  return { message: `Pod deleted: ${podName}` };
}

async function restartPod(ctx, podName) {
  const result = await deletePod(ctx, podName);
  return { ...result, operation: "restart" };
}

async function getPodStatus(ctx, podName) {
  const pod = await describePod(ctx, podName);
  return {
    name: pod.name,
    phase: pod.state || "unknown",
    conditions: (pod.status?.conditions || []).map((item) => ({
      type: item.type,
      status: item.status,
      reason: item.reason || null,
      message: item.message || null
    })),
    podIP: pod.status?.podIp || null,
    nodeName: pod.nodeId || null
  };
}

module.exports = {
  listPods,
  describePod,
  deletePod,
  restartPod,
  getPodStatus
};
