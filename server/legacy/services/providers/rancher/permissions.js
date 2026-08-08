"use strict";

const { buildKubeConfig } = require("./kubeconfig-proxy");

async function checkVerb(ctx, { namespace, verb, resource, subresource }) {
  const { authorizationV1 } = await buildKubeConfig(ctx);
  const result = await authorizationV1.createSelfSubjectAccessReview({
    body: {
      spec: {
        resourceAttributes: {
          namespace,
          verb,
          resource,
          group: "",
          version: "v1",
          ...(subresource ? { subresource } : {})
        }
      }
    }
  });
  return Boolean(result.status?.allowed);
}

module.exports = { checkVerb };
