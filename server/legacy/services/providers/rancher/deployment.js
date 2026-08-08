const yaml = require("js-yaml");
const { AppError } = require("../../../utils/error");
const { rancherRequest, projectPrefix } = require("../../rancher.client");

// NOTE: thao tác ghi (restart/scale) qua Rancher Norman API chưa được test với credentials
// thật (xem PhanTich/rancher-api-notes.md mục 3). Test trên 1 deployment không quan trọng
// trước khi dùng cho service prod.

function summarizeDeployment(item) {
  // Bug thật đã gặp: workload Rancher (Norman API) trả trạng thái dưới key `deploymentStatus`,
  // KHÔNG phải `status` — đọc nhầm `item.status` luôn ra undefined → availableReplicas fallback
  // về 0 dù deployment thật đã Available, khiến /provision/readiness báo sai "chưa sẵn sàng".
  const status = item.deploymentStatus || item.status || {};
  return {
    name: item.name,
    replicas: item.scale ?? 0,
    availableReplicas: status.availableReplicas ?? 0,
    readyReplicas: status.readyReplicas ?? 0,
    updatedReplicas: status.updatedReplicas ?? 0,
    createdAt: item.created || null
  };
}

async function listDeployments(ctx) {
  const response = await rancherRequest(ctx, {
    path: `${projectPrefix(ctx)}/workloads?type=deployment&limit=-1`
  });
  const items = (response.data || []).filter((item) => item.namespaceId === ctx.namespace);
  return items.map(summarizeDeployment);
}

async function findRawDeployment(ctx, deploymentName) {
  const response = await rancherRequest(ctx, {
    path: `${projectPrefix(ctx)}/workloads/deployment:${ctx.namespace}:${deploymentName}`
  });
  if (!response) {
    throw new AppError(`Deployment not found: ${deploymentName}`, 404);
  }
  return response;
}

async function describeDeployment(ctx, deploymentName) {
  try {
    return await findRawDeployment(ctx, deploymentName);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(`Deployment not found: ${deploymentName}`, 404);
  }
}

async function getDeploymentYaml(ctx, deploymentName) {
  const deployment = await describeDeployment(ctx, deploymentName);
  return yaml.dump(deployment, { noRefs: true, lineWidth: -1 });
}

async function restartDeployment(ctx, deploymentName) {
  const deployment = await findRawDeployment(ctx, deploymentName);
  deployment.annotations = deployment.annotations || {};
  deployment.annotations["cattle.io/timestamp"] = new Date().toISOString();

  await rancherRequest(ctx, {
    method: "PUT",
    path: `${projectPrefix(ctx)}/workloads/deployment:${ctx.namespace}:${deploymentName}`,
    body: deployment
  });

  return { message: `Deployment restarted: ${deploymentName}` };
}

async function scaleDeployment(ctx, deploymentName, replicas) {
  const deployment = await findRawDeployment(ctx, deploymentName);
  deployment.scale = replicas;

  await rancherRequest(ctx, {
    method: "PUT",
    path: `${projectPrefix(ctx)}/workloads/deployment:${ctx.namespace}:${deploymentName}`,
    body: deployment
  });

  return { message: `Deployment scaled: ${deploymentName}`, replicas };
}

async function setDeploymentImage(ctx, deploymentName, image, containerName) {
  const deployment = await findRawDeployment(ctx, deploymentName);
  const containers = deployment.containers || [];
  const targetName = containerName || deploymentName;
  const container = containers.find((c) => c.name === targetName);
  if (!container) {
    throw new AppError(
      `Không tìm thấy container "${targetName}" trong deployment "${deploymentName}".`,
      404,
      { availableContainers: containers.map((c) => c.name) }
    );
  }
  container.image = image;

  await rancherRequest(ctx, {
    method: "PUT",
    path: `${projectPrefix(ctx)}/workloads/deployment:${ctx.namespace}:${deploymentName}`,
    body: deployment
  });

  return { message: `Deployment image updated: ${deploymentName}`, container: targetName, image };
}

async function deleteDeployment(ctx, deploymentName) {
  await rancherRequest(ctx, {
    method: "DELETE",
    path: `${projectPrefix(ctx)}/workloads/deployment:${ctx.namespace}:${deploymentName}`
  });
  return { message: `Deployment deleted: ${deploymentName}` };
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
