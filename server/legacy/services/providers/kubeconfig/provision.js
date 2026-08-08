'use strict';

const yaml = require("js-yaml");
const { AppError } = require("../../../utils/error");
const { unwrapK8sResponse } = require("../../../utils/k8s-response");

// Map kind → {api, resourceActions} dùng @kubernetes/client-node
// api: tên field trong ctx, create/read/update: tên method tương ứng
const KIND_MAP = {
  ConfigMap: {
    api: "coreV1",
    apiVersion: "v1",
    create: (ctx, doc) => ctx.coreV1.createNamespacedConfigMap({ namespace: ctx.namespace, body: doc }),
    read:   (ctx, name) => ctx.coreV1.readNamespacedConfigMap({ name, namespace: ctx.namespace }),
    update: (ctx, name, doc) => ctx.coreV1.replaceNamespacedConfigMap({ name, namespace: ctx.namespace, body: doc })
  },
  Deployment: {
    api: "appsV1",
    apiVersion: "apps/v1",
    create: (ctx, doc) => ctx.appsV1.createNamespacedDeployment({ namespace: ctx.namespace, body: doc }),
    read:   (ctx, name) => ctx.appsV1.readNamespacedDeployment({ name, namespace: ctx.namespace }),
    update: (ctx, name, doc) => ctx.appsV1.replaceNamespacedDeployment({ name, namespace: ctx.namespace, body: doc })
  },
  Service: {
    api: "coreV1",
    apiVersion: "v1",
    create: (ctx, doc) => ctx.coreV1.createNamespacedService({ namespace: ctx.namespace, body: doc }),
    read:   (ctx, name) => ctx.coreV1.readNamespacedService({ name, namespace: ctx.namespace }),
    update: (ctx, name, doc) => ctx.coreV1.replaceNamespacedService({ name, namespace: ctx.namespace, body: doc })
  },
  Ingress: {
    api: "networkingV1",
    apiVersion: "networking.k8s.io/v1",
    create: (ctx, doc) => ctx.networkingV1.createNamespacedIngress({ namespace: ctx.namespace, body: doc }),
    read:   (ctx, name) => ctx.networkingV1.readNamespacedIngress({ name, namespace: ctx.namespace }),
    update: (ctx, name, doc) => ctx.networkingV1.replaceNamespacedIngress({ name, namespace: ctx.namespace, body: doc })
  },
  Secret: {
    api: "coreV1",
    apiVersion: "v1",
    create: (ctx, doc) => ctx.coreV1.createNamespacedSecret({ namespace: ctx.namespace, body: doc }),
    read:   (ctx, name) => ctx.coreV1.readNamespacedSecret({ name, namespace: ctx.namespace }),
    update: (ctx, name, doc) => ctx.coreV1.replaceNamespacedSecret({ name, namespace: ctx.namespace, body: doc })
  }
};

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

  // Thử đọc resource hiện có để lấy resourceVersion
  let existing = null;
  try {
    const resp = await kindInfo.read(ctx, name);
    existing = unwrapK8sResponse(resp);
  } catch (err) {
    if (Number(err.statusCode) !== 404) {
      throw new AppError(err.body?.message || `Failed to read ${kind} ${name}`, Number(err.statusCode) || 500);
    }
  }

  if (existing) {
    doc.metadata.resourceVersion = existing.metadata?.resourceVersion;
    try {
      await kindInfo.update(ctx, name, doc);
      return { action: "updated", kind, name };
    } catch (err) {
      throw new AppError(err.body?.message || `Failed to update ${kind} ${name}`, Number(err.statusCode) || 400);
    }
  }

  try {
    await kindInfo.create(ctx, doc);
    return { action: "created", kind, name };
  } catch (err) {
    throw new AppError(err.body?.message || `Failed to create ${kind} ${name}`, Number(err.statusCode) || 400);
  }
}

module.exports = { applyYaml };
