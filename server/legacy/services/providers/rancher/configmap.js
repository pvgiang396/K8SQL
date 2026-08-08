const yaml = require("js-yaml");
const { AppError } = require("../../../utils/error");
const { rancherRequest, projectPrefix } = require("../../rancher.client");

// NOTE: thao tác ghi (update key) qua Rancher Norman API chưa được test với credentials thật
// (xem PhanTich/rancher-api-notes.md mục 3).

async function readConfigMap(ctx, configMapName) {
  const response = await rancherRequest(ctx, {
    path: `${projectPrefix(ctx)}/configmaps/${ctx.namespace}:${configMapName}`
  });
  if (!response) {
    throw new AppError(`ConfigMap not found: ${configMapName}`, 404);
  }
  return response;
}

async function getConfigMapYaml(ctx, configMapName) {
  const configMap = await readConfigMap(ctx, configMapName);
  return yaml.dump(configMap, { noRefs: true, lineWidth: -1 });
}

async function updateConfigMapKey(ctx, configMapName, key, value) {
  const configMap = await readConfigMap(ctx, configMapName);
  configMap.data = configMap.data || {};
  configMap.data[key] = String(value);

  await rancherRequest(ctx, {
    method: "PUT",
    path: `${projectPrefix(ctx)}/configmaps/${ctx.namespace}:${configMapName}`,
    body: configMap
  });

  return {
    message: `ConfigMap key updated: ${configMapName}.${key}`,
    key,
    value: String(value)
  };
}

async function deleteConfigMap(ctx, configMapName) {
  await rancherRequest(ctx, {
    method: "DELETE",
    path: `${projectPrefix(ctx)}/configmaps/${ctx.namespace}:${configMapName}`
  });
  return { message: `ConfigMap deleted: ${configMapName}` };
}

module.exports = {
  readConfigMap,
  getConfigMapYaml,
  updateConfigMapKey,
  deleteConfigMap
};
