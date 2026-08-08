const { AppError } = require("../utils/error");
const { readNamespacesConfig, domainUrl } = require("./kube.service");
const rancherClient = require("./rancher.client");

function normalizeHost(host) {
  return String(host || "").trim().toLowerCase();
}

function normalizeDomain(domain) {
  return String(domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

async function listClusterHosts(rancherClusterName) {
  const rancherCtx = await rancherClient.resolveRancherCluster(rancherClusterName);

  const projectsResponse = await rancherClient.rancherRequest(rancherCtx, {
    path: `/v3/project?limit=-1`
  });
  const projects = (projectsResponse.data || []).filter(
    (item) => item.clusterId === rancherCtx.clusterId
  );

  const hosts = [];
  for (const project of projects) {
    const ctx = { ...rancherCtx, projectId: project.id.split(":")[1] || project.id };
    let ingressResponse;
    try {
      ingressResponse = await rancherClient.rancherRequest(ctx, {
        path: `${rancherClient.projectPrefix(ctx)}/ingresses?limit=-1`
      });
    } catch {
      continue;
    }

    for (const ingress of ingressResponse.data || []) {
      for (const rule of ingress.rules || []) {
        if (!rule.host) {
          continue;
        }
        hosts.push({
          host: normalizeHost(rule.host),
          projectId: ctx.projectId,
          projectName: project.name,
          namespaceId: ingress.namespaceId,
          ingressName: ingress.name
        });
      }
    }
  }

  return hosts;
}

async function reconcileCluster(rancherClusterName) {
  if (!rancherClusterName) {
    throw new AppError("Missing required field: rancherCluster", 400);
  }

  const liveHosts = await listClusterHosts(rancherClusterName);
  const liveHostSet = new Map(liveHosts.map((item) => [item.host, item]));

  const namespaceConfigs = await readNamespacesConfig();
  const configuredEntries = namespaceConfigs.filter(
    (item) => item.rancherCluster === rancherClusterName
  );
  const configuredDomains = new Map();
  for (const entry of configuredEntries) {
    for (const domain of entry.domains || []) {
      configuredDomains.set(normalizeDomain(domainUrl(domain)), entry);
    }
  }

  const matched = [];
  const staleInConfig = [];
  for (const [domain, entry] of configuredDomains) {
    const live = liveHostSet.get(domain);
    if (live) {
      matched.push({ domain, namespace: entry.namespace, projectId: live.projectId, host: live });
    } else {
      staleInConfig.push({ domain, namespace: entry.namespace, entryName: entry.name });
    }
  }

  const missingInConfig = liveHosts.filter((item) => !configuredDomains.has(item.host));

  return { matched, staleInConfig, missingInConfig };
}

module.exports = {
  reconcileCluster
};
