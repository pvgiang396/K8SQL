const { rancherRequest, clusterProxyPrefix } = require("../../rancher.client");
const podProvider = require("./pod");
const { filterByTimeRange, filterByKeyword, parseTailLines, rawLogToEntries } = require("../log-filter");

// Xác minh 2026-07-23 với credentials thật: log KHÔNG dùng Norman API/WebSocket (endpoint
// /v3/project/.../pods/.../log trả 404 "link not found") — dùng GET thuần qua cluster proxy
// của Rancher, chạy thẳng raw k8s API (không bị RBAC chặn dù list pods/deployments qua raw API
// có bị chặn — sub-resource log của pod được phép qua path này).
function buildLogPath(ctx, podName, { container, previous, tailLines }) {
  const params = new URLSearchParams();
  if (container) {
    params.set("container", container);
  }
  params.set("timestamps", "true");
  if (previous) {
    params.set("previous", "true");
  }
  if (tailLines) {
    params.set("tailLines", String(tailLines));
  }
  return `${clusterProxyPrefix(ctx)}/api/v1/namespaces/${ctx.namespace}/pods/${podName}/log?${params.toString()}`;
}

async function readPodLog(ctx, podName, options) {
  return rancherRequest(ctx, {
    path: buildLogPath(ctx, podName, options),
    responseType: "text"
  });
}

async function searchLogs(ctx, options) {
  const { keyword, previous = false, tailLines, startTime, endTime, pod, container } = options;

  let podNames = [];
  if (pod) {
    podNames = [pod];
  } else {
    const pods = await podProvider.listPods(ctx);
    podNames = pods.map((item) => item.name).filter(Boolean);
  }

  if (!podNames.length) {
    return [];
  }

  const parsedTail = parseTailLines(tailLines);

  const entries = [];
  for (const podName of podNames) {
    const rawLog = await readPodLog(ctx, podName, { container, previous, tailLines: parsedTail });
    entries.push(...rawLogToEntries(podName, rawLog));
  }

  const inTimeRange = filterByTimeRange(entries, startTime, endTime);
  return filterByKeyword(inTimeRange, keyword);
}

module.exports = {
  searchLogs
};
