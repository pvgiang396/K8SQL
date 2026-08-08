const yaml = require("js-yaml");
const { AppError } = require("../../../utils/error");
const { unwrapK8sResponse } = require("../../../utils/k8s-response");

async function readConfigMap(ctx, configMapName) {
  try {
    const response = await ctx.coreV1.readNamespacedConfigMap({
      name: configMapName,
      namespace: ctx.namespace
    });
    return unwrapK8sResponse(response);
  } catch (error) {
    throw new AppError(error.body?.message || `ConfigMap not found: ${configMapName}`, Number(error.statusCode) || 404);
  }
}

async function getConfigMapYaml(ctx, configMapName) {
  const configMap = await readConfigMap(ctx, configMapName);
  return yaml.dump(configMap, { noRefs: true, lineWidth: -1 });
}

async function updateConfigMapKey(ctx, configMapName, key, value) {
  try {
    const response = await ctx.coreV1.readNamespacedConfigMap({
      name: configMapName,
      namespace: ctx.namespace
    });
    const configMap = unwrapK8sResponse(response);
    configMap.data = configMap.data || {};
    configMap.data[key] = String(value);

    await ctx.coreV1.replaceNamespacedConfigMap({
      name: configMapName,
      namespace: ctx.namespace,
      body: configMap
    });

    return {
      message: `ConfigMap key updated: ${configMapName}.${key}`,
      key,
      value: String(value)
    };
  } catch (error) {
    throw new AppError(error.body?.message || `Failed to update ConfigMap key: ${configMapName}.${key}`, Number(error.statusCode) || 400);
  }
}

async function deleteConfigMap(ctx, configMapName) {
  try {
    await ctx.coreV1.deleteNamespacedConfigMap({ name: configMapName, namespace: ctx.namespace });
    return { message: `ConfigMap deleted: ${configMapName}` };
  } catch (error) {
    throw new AppError(error.body?.message || `Failed to delete ConfigMap: ${configMapName}`, Number(error.statusCode) || 400);
  }
}

module.exports = {
  readConfigMap,
  getConfigMapYaml,
  updateConfigMapKey,
  deleteConfigMap
};
