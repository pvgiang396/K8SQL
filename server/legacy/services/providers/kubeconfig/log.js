const { AppError } = require("../../../utils/error");
const { unwrapK8sResponse } = require("../../../utils/k8s-response");
const { filterByTimeRange, filterByKeyword, parseTailLines, rawLogToEntries } = require("../log-filter");

async function searchLogs(ctx, options) {
  const { keyword, previous = false, tailLines, startTime, endTime, pod, container } = options;

  try {
    let podNames = [];
    if (pod) {
      podNames = [pod];
    } else {
      const podListResponse = await ctx.coreV1.listNamespacedPod({ namespace: ctx.namespace });
      const podList = unwrapK8sResponse(podListResponse);
      podNames = (podList.items || []).map((item) => item.metadata?.name).filter(Boolean);
    }

    if (!podNames.length) {
      return [];
    }

    const parsedTail = parseTailLines(tailLines);

    const entries = [];
    for (const podName of podNames) {
      const rawLogResponse = await ctx.coreV1.readNamespacedPodLog({
        name: podName,
        namespace: ctx.namespace,
        container,
        previous: Boolean(previous),
        tailLines: parsedTail,
        timestamps: true
      });
      const rawLog = unwrapK8sResponse(rawLogResponse);
      entries.push(...rawLogToEntries(podName, rawLog));
    }

    const inTimeRange = filterByTimeRange(entries, startTime, endTime);
    return filterByKeyword(inTimeRange, keyword);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(error.body?.message || "Failed to retrieve pod logs.", Number(error.statusCode) || 400);
  }
}

module.exports = {
  searchLogs
};
