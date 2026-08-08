'use strict';

const yaml = require("js-yaml");
const { AppError } = require("../../../utils/error");
const { rancherRequest, clusterProxyPrefix } = require("../../rancher.client");

// Map kind → {apiPrefix, resourcePath, apiVersion} của k8s REST API
const KIND_MAP = {
  ConfigMap:  { apiPrefix: "/api/v1",         resourcePath: "configmaps", apiVersion: "v1" },
  Deployment: { apiPrefix: "/apis/apps/v1",   resourcePath: "deployments", apiVersion: "apps/v1" },
  Service:    { apiPrefix: "/api/v1",         resourcePath: "services", apiVersion: "v1" },
  Ingress:    { apiPrefix: "/apis/networking.k8s.io/v1", resourcePath: "ingresses", apiVersion: "networking.k8s.io/v1" },
  Secret:     { apiPrefix: "/api/v1",         resourcePath: "secrets", apiVersion: "v1" }
};

function buildClusterProxyPath(ctx, apiPrefix, resourcePath, name) {
  const base = `${clusterProxyPrefix(ctx)}${apiPrefix}/namespaces/${ctx.namespace}/${resourcePath}`;
  return name ? `${base}/${name}` : base;
}

async function applyYaml(ctx, yamlContent) {
  let doc;
  try {
    doc = yaml.load(yamlContent);
  } catch (err) {
    throw new AppError(`YAML parse error: ${err.message}`, 400);
  }

  if (!doc || typeof doc !== "object") {
    throw new AppError("YAML không chứa object hợp lệ.", 400);
  }

  const kind = doc.kind;
  const name = doc.metadata?.name;

  if (!kind || !name) {
    throw new AppError("YAML thiếu kind hoặc metadata.name.", 400);
  }

  const kindInfo = KIND_MAP[kind];
  if (!kindInfo) {
    throw new AppError(
      `kind "${kind}" chưa được hỗ trợ. Hỗ trợ: ${Object.keys(KIND_MAP).join(", ")}.`,
      400
    );
  }

  if (doc.apiVersion !== kindInfo.apiVersion) {
    throw new AppError(
      `apiVersion "${doc.apiVersion}" không khớp kind "${kind}" — phải là "${kindInfo.apiVersion}".`,
      400
    );
  }

  // metadata.namespace nếu có phải khớp ctx.namespace — không âm thầm ghi đè, tránh apply nhầm
  // namespace khác với namespace đã xác định qua rancherCluster/configPath.
  if (doc.metadata.namespace && doc.metadata.namespace !== ctx.namespace) {
    throw new AppError(
      `metadata.namespace "${doc.metadata.namespace}" khác với namespace đích "${ctx.namespace}".`,
      400
    );
  }
  doc.metadata.namespace = ctx.namespace;

  const createPath = buildClusterProxyPath(ctx, kindInfo.apiPrefix, kindInfo.resourcePath, null);
  const updatePath = buildClusterProxyPath(ctx, kindInfo.apiPrefix, kindInfo.resourcePath, name);

  // Thử GET để biết resource đã tồn tại chưa (dùng resourceVersion khi PUT)
  let existing = null;
  try {
    existing = await rancherRequest(ctx, { path: updatePath });
  } catch (err) {
    if (err.statusCode !== 404 && err.message && !err.message.includes("not found")) {
      // Lỗi khác 404 → ném lên
      throw err;
    }
  }

  if (existing) {
    // Giữ resourceVersion để tránh conflict
    doc.metadata.resourceVersion = existing.metadata?.resourceVersion;
    await rancherRequest(ctx, { method: "PUT", path: updatePath, body: doc });
    return { action: "updated", kind, name };
  }

  await rancherRequest(ctx, { method: "POST", path: createPath, body: doc });
  return { action: "created", kind, name };
}

module.exports = { applyYaml };
