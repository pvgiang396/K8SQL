const yaml = require("js-yaml");
const { AppError } = require("../../../utils/error");
const { unwrapK8sResponse } = require("../../../utils/k8s-response");
const { decodeSecretData } = require("../../../utils/secret-codec");

async function readSecret(ctx, secretName) {
  try {
    const response = await ctx.coreV1.readNamespacedSecret({
      name: secretName,
      namespace: ctx.namespace
    });
    const secret = unwrapK8sResponse(response);
    return {
      name: secret.metadata?.name,
      type: secret.type || null,
      createdAt: secret.metadata?.creationTimestamp || null,
      data: decodeSecretData(secret.data)
    };
  } catch (error) {
    throw new AppError(error.body?.message || `Secret not found: ${secretName}`, Number(error.statusCode) || 404);
  }
}

async function getSecretYaml(ctx, secretName) {
  const secret = await readSecret(ctx, secretName);
  return yaml.dump(secret, { noRefs: true, lineWidth: -1 });
}

module.exports = {
  readSecret,
  getSecretYaml
};
