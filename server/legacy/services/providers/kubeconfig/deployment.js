const yaml = require("js-yaml");
const { AppError } = require("../../../utils/error");
const { unwrapK8sResponse } = require("../../../utils/k8s-response");

function summarizeDeployment(deployment) {
  return {
    name: deployment.metadata?.name,
    replicas: deployment.spec?.replicas ?? 0,
    availableReplicas: deployment.status?.availableReplicas ?? 0,
    readyReplicas: deployment.status?.readyReplicas ?? 0,
    updatedReplicas: deployment.status?.updatedReplicas ?? 0,
    createdAt: deployment.metadata?.creationTimestamp || null
  };
}

async function listDeployments(ctx) {
  const result = await ctx.appsV1.listNamespacedDeployment({ namespace: ctx.namespace });
  const list = unwrapK8sResponse(result);
  return (list.items || []).map(summarizeDeployment);
}

async function describeDeployment(ctx, deploymentName) {
  try {
    const deploymentResponse = await ctx.appsV1.readNamespacedDeployment({
      name: deploymentName,
      namespace: ctx.namespace
    });
    return unwrapK8sResponse(deploymentResponse);
  } catch (error) {
    throw new AppError(error.body?.message || `Deployment not found: ${deploymentName}`, Number(error.statusCode) || 404);
  }
}

async function getDeploymentYaml(ctx, deploymentName) {
  const deployment = await describeDeployment(ctx, deploymentName);
  return yaml.dump(deployment, { noRefs: true, lineWidth: -1 });
}

async function restartDeployment(ctx, deploymentName) {
  try {
    const response = await ctx.appsV1.readNamespacedDeployment({
      name: deploymentName,
      namespace: ctx.namespace
    });
    const deployment = unwrapK8sResponse(response);
    deployment.spec = deployment.spec || {};
    deployment.spec.template = deployment.spec.template || {};
    deployment.spec.template.metadata = deployment.spec.template.metadata || {};
    deployment.spec.template.metadata.annotations = deployment.spec.template.metadata.annotations || {};
    deployment.spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"] = new Date().toISOString();

    await ctx.appsV1.replaceNamespacedDeployment({
      name: deploymentName,
      namespace: ctx.namespace,
      body: deployment
    });

    return { message: `Deployment restarted: ${deploymentName}` };
  } catch (error) {
    throw new AppError(error.body?.message || `Failed to restart deployment: ${deploymentName}`, Number(error.statusCode) || 400);
  }
}

async function scaleDeployment(ctx, deploymentName, replicas) {
  try {
    const current = await ctx.appsV1.readNamespacedDeployment({
      name: deploymentName,
      namespace: ctx.namespace
    });
    const deployment = unwrapK8sResponse(current);
    deployment.spec = deployment.spec || {};
    deployment.spec.replicas = replicas;

    await ctx.appsV1.replaceNamespacedDeployment({
      name: deploymentName,
      namespace: ctx.namespace,
      body: deployment
    });

    return { message: `Deployment scaled: ${deploymentName}`, replicas };
  } catch (error) {
    throw new AppError(error.body?.message || `Failed to scale deployment: ${deploymentName}`, Number(error.statusCode) || 400);
  }
}

async function setDeploymentImage(ctx, deploymentName, image, containerName) {
  try {
    const current = await ctx.appsV1.readNamespacedDeployment({
      name: deploymentName,
      namespace: ctx.namespace
    });
    const deployment = unwrapK8sResponse(current);
    const containers = deployment.spec?.template?.spec?.containers || [];
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

    await ctx.appsV1.replaceNamespacedDeployment({
      name: deploymentName,
      namespace: ctx.namespace,
      body: deployment
    });

    return { message: `Deployment image updated: ${deploymentName}`, container: targetName, image };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(error.body?.message || `Failed to set image for deployment: ${deploymentName}`, Number(error.statusCode) || 400);
  }
}

async function deleteDeployment(ctx, deploymentName) {
  try {
    await ctx.appsV1.deleteNamespacedDeployment({ name: deploymentName, namespace: ctx.namespace });
    return { message: `Deployment deleted: ${deploymentName}` };
  } catch (error) {
    throw new AppError(error.body?.message || `Failed to delete deployment: ${deploymentName}`, Number(error.statusCode) || 400);
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
