const { AppError } = require("../utils/error");
const { getGroupEntryByDomain, getDomainEnv } = require("./kube.service");

async function resolveGroup(domain) {
  const entry = await getGroupEntryByDomain(domain);
  return {
    name: entry.name,
    provider: entry.provider || "kubeconfig",
    namespace: entry.namespace,
    env: getDomainEnv(entry, domain),
    domains: entry.domains || [],
    services: entry.services || {}
  };
}

async function resolveServiceName(domain, serviceKey, resourceType = "deployment") {
  const entry = await getGroupEntryByDomain(domain);
  const service = (entry.services || {})[serviceKey];
  const name = service?.[resourceType];

  if (!name) {
    throw new AppError(
      `No "${resourceType}" name mapped for service "${serviceKey}" in namespaces.json entry "${entry.name}". ` +
        `Khai báo trong entry.services.${serviceKey}.${resourceType}.`,
      404
    );
  }

  return name;
}

module.exports = {
  resolveGroup,
  resolveServiceName
};
