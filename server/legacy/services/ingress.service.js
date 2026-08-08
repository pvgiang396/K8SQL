const { createKubeContextByDomain } = require("./kube.service");
const { logOperation } = require("../utils/logger");
const kubeconfigIngress = require("./providers/kubeconfig/ingress");
const rancherIngress = require("./providers/rancher/ingress");

function implFor(ctx) {
  return ctx.provider === "rancher" ? rancherIngress : kubeconfigIngress;
}

async function listIngresses(domain) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).listIngresses(ctx);
    logOperation({ ...ctx, resource: "ingress", operation: "list", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "ingress", operation: "list", success: false, error: error.message });
    throw error;
  }
}

async function describeIngress(domain, ingressName) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).describeIngress(ctx, ingressName);
    logOperation({ ...ctx, resource: "ingress", operation: "describe", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "ingress", operation: "describe", success: false, error: error.message });
    throw error;
  }
}

async function getIngressYaml(domain, ingressName) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).getIngressYaml(ctx, ingressName);
    logOperation({ ...ctx, resource: "ingress", operation: "yaml", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "ingress", operation: "yaml", success: false, error: error.message });
    throw error;
  }
}

async function upsertIngress(domain, spec) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).upsertIngress(ctx, spec);
    logOperation({ ...ctx, resource: "ingress", operation: "upsert", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "ingress", operation: "upsert", success: false, error: error.message });
    throw error;
  }
}

async function annotateIngress(domain, ingressName, annotations) {
  const ctx = await createKubeContextByDomain(domain);
  try {
    const data = await implFor(ctx).annotateIngress(ctx, ingressName, annotations);
    logOperation({ ...ctx, resource: "ingress", operation: "annotate", success: true });
    return data;
  } catch (error) {
    logOperation({ ...ctx, resource: "ingress", operation: "annotate", success: false, error: error.message });
    throw error;
  }
}

module.exports = {
  listIngresses,
  describeIngress,
  getIngressYaml,
  upsertIngress,
  annotateIngress
};
