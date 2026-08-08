const { AppError } = require("../utils/error");
const { resolveGroup, resolveServiceName } = require("./resolve.service");
const deploymentService = require("./deployment.service");
const podService = require("./pod.service");
const logService = require("./log.service");

const SUSPICIOUS_PHASES = new Set(["Pending", "Failed", "Unknown"]);
const RESTART_THRESHOLD = 3;
const DEFAULT_TAIL_LINES = 200;
const ERROR_REGEX = /error|exception|fatal|panic|crash/i;

// Gộp resolve + deployment status + pod status + log lỗi thành 1 lần gọi — tránh AI phải
// tự gọi tuần tự 4-5 endpoint rồi suy luận giữa các bước khi chẩn đoán 1 domain/service bị lỗi.
async function diagnose(domain, serviceKey) {
  const group = await resolveGroup(domain);
  const deploymentName = await resolveServiceName(domain, serviceKey, "deployment");

  const [deployments, allPods] = await Promise.all([
    deploymentService.listDeployments(domain),
    podService.listPods(domain)
  ]);

  const deployment = deployments.find((item) => item.name === deploymentName);
  if (!deployment) {
    throw new AppError(
      `Deployment "${deploymentName}" không tìm thấy trong namespace "${group.namespace}".`,
      404
    );
  }

  const pods = allPods.filter((pod) => pod.name && pod.name.startsWith(`${deploymentName}-`));
  const suspiciousPods = pods.filter(
    (pod) => SUSPICIOUS_PHASES.has(pod.phase) || pod.restarts >= RESTART_THRESHOLD
  );

  // Chỉ lấy log của pod nghi vấn; nếu không có pod nào nghi vấn, lấy log pod đầu tiên để vẫn có
  // dữ liệu tham khảo (tránh trả về rỗng khi deployment trông "khỏe" nhưng vẫn có lỗi ẩn trong log).
  const logTargetPods = suspiciousPods.length > 0 ? suspiciousPods : pods.slice(0, 1);

  const recentErrorLogs = [];
  for (const pod of logTargetPods) {
    try {
      const entries = await logService.searchLogs({
        domain,
        pod: pod.name,
        tailLines: DEFAULT_TAIL_LINES
      });
      recentErrorLogs.push({
        pod: pod.name,
        entries: entries.filter((entry) => ERROR_REGEX.test(entry.message))
      });
    } catch (error) {
      recentErrorLogs.push({ pod: pod.name, error: error.message });
    }
  }

  return {
    group: { name: group.name, namespace: group.namespace, provider: group.provider },
    deploymentName,
    deployment,
    pods,
    suspiciousPods,
    recentErrorLogs
  };
}

module.exports = {
  diagnose
};
