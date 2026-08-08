const yaml = require("js-yaml");
const { AppError } = require("../../../utils/error");
const { rancherRequest, projectPrefix } = require("../../rancher.client");
const { decodeSecretData } = require("../../../utils/secret-codec");

async function readSecret(ctx, secretName) {
  const response = await rancherRequest(ctx, {
    path: `${projectPrefix(ctx)}/secrets/${ctx.namespace}:${secretName}`
  });
  if (!response) {
    throw new AppError(`Secret not found: ${secretName}`, 404);
  }
  return {
    name: response.name,
    type: response.kind || null,
    createdAt: response.created || null,
    data: decodeSecretData(response.data)
  };
}

async function getSecretYaml(ctx, secretName) {
  const secret = await readSecret(ctx, secretName);
  return yaml.dump(secret, { noRefs: true, lineWidth: -1 });
}

module.exports = {
  readSecret,
  getSecretYaml
};
