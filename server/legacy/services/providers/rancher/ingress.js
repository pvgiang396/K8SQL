const yaml = require("js-yaml");
const { AppError } = require("../../../utils/error");
const { rancherRequest, projectPrefix } = require("../../rancher.client");

function summarizeIngress(item) {
  return {
    name: item.name,
    hosts: (item.rules || []).map((rule) => rule.host).filter(Boolean),
    className: item.ingressClassName || null,
    createdAt: item.created || null
  };
}

async function listIngresses(ctx) {
  const response = await rancherRequest(ctx, { path: `${projectPrefix(ctx)}/ingresses?limit=-1` });
  const items = (response.data || []).filter((item) => item.namespaceId === ctx.namespace);
  return items.map(summarizeIngress);
}

async function findRawIngress(ctx, ingressName) {
  const response = await rancherRequest(ctx, {
    path: `${projectPrefix(ctx)}/ingresses/${ctx.namespace}:${ingressName}`
  });
  if (!response) {
    throw new AppError(`Ingress not found: ${ingressName}`, 404);
  }
  return response;
}

async function describeIngress(ctx, ingressName) {
  try {
    return await findRawIngress(ctx, ingressName);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(`Ingress not found: ${ingressName}`, 404);
  }
}

async function getIngressYaml(ctx, ingressName) {
  const ingress = await describeIngress(ctx, ingressName);
  return yaml.dump(ingress, { noRefs: true, lineWidth: -1 });
}

function buildAnnotations(spec) {
  return {
    "kubernetes.io/ingress.class": "nginx",
    "nginx.ingress.kubernetes.io/rewrite-target": spec.rewriteTarget,
    "nginx.ingress.kubernetes.io/proxy-read-timeout": String(spec.proxyReadTimeoutSec),
    "nginx.ingress.kubernetes.io/proxy-send-timeout": String(spec.proxySendTimeoutSec)
  };
}

// spec.paths là nginx path regex ĐÃ dựng sẵn (kèm capture group khớp spec.rewriteTarget) — k8sctl
// không tự suy đoán/bọc thêm regex, tránh sai ngữ nghĩa rewrite khi path không phải 1 prefix chung
// (xem bug thật: rewrite-target /$2 sai khi path là 1 endpoint cụ thể, đã sửa 2026-07-27 — chi tiết
// docs/team-notes.md #43).
function buildRules(ctx, spec) {
  return [
    {
      host: spec.host,
      paths: spec.paths.map((p) => ({
        path: p,
        pathType: "ImplementationSpecific",
        serviceId: `${ctx.namespace}:${spec.backendServiceName}`,
        targetPort: spec.backendServicePort,
        type: "/v3/project/schemas/httpIngressPath"
      })),
      type: "/v3/project/schemas/ingressRule"
    }
  ];
}

// NOTE: thao tác ghi (create/update) qua Rancher Norman API chưa được test với credentials
// thật (xem PhanTich/rancher-api-notes.md mục 3) — test trên 1 ingress không quan trọng trước
// khi dùng cho ingress phục vụ traffic thật.
// spec = {name, host, paths[], rewriteTarget?, proxyReadTimeoutSec, proxySendTimeoutSec,
//         backendServiceName, backendServicePort}
async function upsertIngress(ctx, spec) {
  let existing;
  try {
    existing = await findRawIngress(ctx, spec.name);
  } catch (error) {
    if (!(error instanceof AppError) || error.statusCode !== 404) {
      throw error;
    }
  }

  if (existing) {
    existing.annotations = buildAnnotations(spec);
    existing.rules = buildRules(ctx, spec);
    await rancherRequest(ctx, {
      method: "PUT",
      path: `${projectPrefix(ctx)}/ingresses/${ctx.namespace}:${spec.name}`,
      body: existing
    });
    return { message: `Ingress updated: ${spec.name}`, action: "updated" };
  }

  await rancherRequest(ctx, {
    method: "POST",
    path: `${projectPrefix(ctx)}/ingress`,
    body: {
      type: "ingress",
      name: spec.name,
      namespaceId: ctx.namespace,
      annotations: buildAnnotations(spec),
      rules: buildRules(ctx, spec)
    }
  });
  return { message: `Ingress created: ${spec.name}`, action: "created" };
}

// Chỉ merge/ghi đè key trong `annotations` vào Ingress đã có — KHÔNG đụng `rules`/path/backend.
// An toàn hơn upsertIngress() cho việc sửa 1 Ingress ĐANG phục vụ traffic thật (vd nới timeout) vì
// không có rủi ro ghi đè nhầm route hiện có. Ingress phải đã tồn tại — không tự tạo mới. Đã xác
// minh hoạt động đúng với credentials thật trên 1 Ingress production thực tế.
async function annotateIngress(ctx, ingressName, annotations) {
  const existing = await findRawIngress(ctx, ingressName);
  existing.annotations = { ...(existing.annotations || {}), ...annotations };
  await rancherRequest(ctx, {
    method: "PUT",
    path: `${projectPrefix(ctx)}/ingresses/${ctx.namespace}:${ingressName}`,
    body: existing
  });
  return { message: `Ingress annotations updated: ${ingressName}`, annotations: existing.annotations };
}

async function deleteIngress(ctx, ingressName) {
  await rancherRequest(ctx, {
    method: "DELETE",
    path: `${projectPrefix(ctx)}/ingresses/${ctx.namespace}:${ingressName}`
  });
  return { message: `Ingress deleted: ${ingressName}` };
}

module.exports = {
  listIngresses,
  describeIngress,
  getIngressYaml,
  upsertIngress,
  annotateIngress,
  deleteIngress
};
