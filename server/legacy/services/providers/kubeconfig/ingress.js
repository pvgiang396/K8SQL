const yaml = require("js-yaml");
const { AppError } = require("../../../utils/error");
const { unwrapK8sResponse } = require("../../../utils/k8s-response");

function summarizeIngress(item) {
  return {
    name: item.metadata?.name,
    hosts: (item.spec?.rules || []).map((rule) => rule.host).filter(Boolean),
    className: item.spec?.ingressClassName || null,
    createdAt: item.metadata?.creationTimestamp || null
  };
}

async function listIngresses(ctx) {
  const response = await ctx.networkingV1.listNamespacedIngress({ namespace: ctx.namespace });
  const list = unwrapK8sResponse(response);
  return (list.items || []).map(summarizeIngress);
}

async function describeIngress(ctx, ingressName) {
  try {
    const response = await ctx.networkingV1.readNamespacedIngress({
      name: ingressName,
      namespace: ctx.namespace
    });
    return unwrapK8sResponse(response);
  } catch (error) {
    throw new AppError(error.body?.message || `Ingress not found: ${ingressName}`, Number(error.statusCode) || 404);
  }
}

async function getIngressYaml(ctx, ingressName) {
  const ingress = await describeIngress(ctx, ingressName);
  return yaml.dump(ingress, { noRefs: true, lineWidth: -1 });
}

function buildIngressBody(spec) {
  return {
    metadata: {
      name: spec.name,
      namespace: spec.namespace,
      annotations: {
        "kubernetes.io/ingress.class": "nginx",
        "nginx.ingress.kubernetes.io/rewrite-target": spec.rewriteTarget,
        "nginx.ingress.kubernetes.io/proxy-read-timeout": String(spec.proxyReadTimeoutSec),
        "nginx.ingress.kubernetes.io/proxy-send-timeout": String(spec.proxySendTimeoutSec)
      }
    },
    spec: {
      rules: [
        {
          host: spec.host,
          http: {
            // spec.paths là nginx path regex ĐÃ dựng sẵn (kèm capture group khớp spec.rewriteTarget) —
            // k8sctl không tự suy đoán/bọc thêm regex, tránh sai ngữ nghĩa rewrite khi path không phải
            // 1 prefix chung (xem bug thật: rewrite-target /$2 sai khi path là 1 endpoint cụ thể, đã
            // sửa 2026-07-27 — chi tiết docs/team-notes.md #43).
            paths: spec.paths.map((p) => ({
              path: p,
              pathType: "ImplementationSpecific",
              backend: {
                service: {
                  name: spec.backendServiceName,
                  port: { number: spec.backendServicePort }
                }
              }
            }))
          }
        }
      ]
    }
  };
}

// spec = {name, host, paths[], rewriteTarget?, proxyReadTimeoutSec, proxySendTimeoutSec,
//         backendServiceName, backendServicePort} — tạo mới nếu chưa có Ingress cùng tên trong
// namespace, ngược lại thay thế nguyên spec/annotations (giữ nguyên resourceVersion đọc được).
async function upsertIngress(ctx, spec) {
  const body = buildIngressBody({ ...spec, namespace: ctx.namespace });
  try {
    const existing = await ctx.networkingV1.readNamespacedIngress({
      name: spec.name,
      namespace: ctx.namespace
    });
    const current = unwrapK8sResponse(existing);
    body.metadata.resourceVersion = current.metadata?.resourceVersion;
    await ctx.networkingV1.replaceNamespacedIngress({
      name: spec.name,
      namespace: ctx.namespace,
      body
    });
    return { message: `Ingress updated: ${spec.name}`, action: "updated" };
  } catch (error) {
    if (Number(error.statusCode) !== 404) {
      throw new AppError(error.body?.message || `Failed to upsert Ingress: ${spec.name}`, Number(error.statusCode) || 400);
    }
  }

  try {
    await ctx.networkingV1.createNamespacedIngress({ namespace: ctx.namespace, body });
    return { message: `Ingress created: ${spec.name}`, action: "created" };
  } catch (error) {
    throw new AppError(error.body?.message || `Failed to create Ingress: ${spec.name}`, Number(error.statusCode) || 400);
  }
}

// Chỉ merge/ghi đè các key trong `annotations` vào Ingress đã có — KHÔNG đụng `spec.rules`/path/backend.
// An toàn hơn upsertIngress() cho việc sửa 1 Ingress ĐANG phục vụ traffic thật (vd nới timeout) vì
// không có rủi ro ghi đè nhầm route hiện có. Ingress phải đã tồn tại — không tự tạo mới.
async function annotateIngress(ctx, ingressName, annotations) {
  let existing;
  try {
    const response = await ctx.networkingV1.readNamespacedIngress({
      name: ingressName,
      namespace: ctx.namespace
    });
    existing = unwrapK8sResponse(response);
  } catch (error) {
    throw new AppError(error.body?.message || `Ingress not found: ${ingressName}`, Number(error.statusCode) || 404);
  }

  existing.metadata.annotations = { ...(existing.metadata.annotations || {}), ...annotations };

  try {
    await ctx.networkingV1.replaceNamespacedIngress({
      name: ingressName,
      namespace: ctx.namespace,
      body: existing
    });
    return { message: `Ingress annotations updated: ${ingressName}`, annotations: existing.metadata.annotations };
  } catch (error) {
    throw new AppError(error.body?.message || `Failed to annotate Ingress: ${ingressName}`, Number(error.statusCode) || 400);
  }
}

module.exports = {
  listIngresses,
  describeIngress,
  getIngressYaml,
  upsertIngress,
  annotateIngress
};
