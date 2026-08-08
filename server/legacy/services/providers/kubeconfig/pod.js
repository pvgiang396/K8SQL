const { AppError } = require("../../../utils/error");
const { unwrapK8sResponse } = require("../../../utils/k8s-response");

function summarizePod(pod) {
  return {
    name: pod.metadata?.name,
    phase: pod.status?.phase || "Unknown",
    nodeName: pod.spec?.nodeName || null,
    podIP: pod.status?.podIP || null,
    restarts: (pod.status?.containerStatuses || []).reduce(
      (total, item) => total + (item.restartCount || 0),
      0
    ),
    createdAt: pod.metadata?.creationTimestamp || null
  };
}

async function listPods(ctx) {
  const response = await ctx.coreV1.listNamespacedPod({ namespace: ctx.namespace });
  const list = unwrapK8sResponse(response);
  return (list.items || []).map(summarizePod);
}

async function describePod(ctx, podName) {
  try {
    const response = await ctx.coreV1.readNamespacedPod({
      name: podName,
      namespace: ctx.namespace
    });
    return unwrapK8sResponse(response);
  } catch (error) {
    throw new AppError(error.body?.message || `Pod not found: ${podName}`, Number(error.statusCode) || 404);
  }
}

async function deletePod(ctx, podName) {
  try {
    await ctx.coreV1.deleteNamespacedPod({
      name: podName,
      namespace: ctx.namespace
    });
    return { message: `Pod deleted: ${podName}` };
  } catch (error) {
    throw new AppError(error.body?.message || `Failed to delete pod: ${podName}`, Number(error.statusCode) || 400);
  }
}

async function restartPod(ctx, podName) {
  const result = await deletePod(ctx, podName);
  return { ...result, operation: "restart" };
}

async function getPodStatus(ctx, podName) {
  const pod = await describePod(ctx, podName);
  return {
    name: pod.metadata?.name,
    phase: pod.status?.phase || "Unknown",
    conditions: (pod.status?.conditions || []).map((item) => ({
      type: item.type,
      status: item.status,
      reason: item.reason || null,
      message: item.message || null
    })),
    podIP: pod.status?.podIP || null,
    nodeName: pod.spec?.nodeName || null
  };
}

module.exports = {
  listPods,
  describePod,
  deletePod,
  restartPod,
  getPodStatus
};
