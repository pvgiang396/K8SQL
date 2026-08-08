"use strict";

const { clusterProxyPrefix } = require("../../rancher.client");

// Dựng 1 KubeConfig "tổng hợp" trỏ thẳng cluster-proxy của Rancher (server =
// `<rancherUrl>/k8s/clusters/<clusterId>`, bearer token = Rancher token) — cùng path đã verify
// hoạt động cho raw k8s API ở services/providers/rancher/log.js (bypass RBAC 403 của Norman API).
// @kubernetes/client-node dùng KubeConfig này y hệt nhánh kubeconfig — dùng chung cho cả
// dbtunnel.js lẫn permissions.js, không viết lại logic port-forward/API client riêng cho Rancher.
async function buildKubeConfig(ctx) {
  const k8s = await import("@kubernetes/client-node").then((moduleValue) => moduleValue.default || moduleValue);
  const kc = new k8s.KubeConfig();
  kc.loadFromOptions({
    clusters: [
      {
        name: "rancher-cluster-proxy",
        server: `${ctx.rancherUrl}${clusterProxyPrefix(ctx)}`,
        skipTLSVerify: Boolean(ctx.insecureTLS)
      }
    ],
    users: [{ name: "rancher-token", token: ctx.token }],
    contexts: [
      {
        name: "rancher-cluster-proxy-ctx",
        cluster: "rancher-cluster-proxy",
        user: "rancher-token",
        namespace: ctx.namespace
      }
    ],
    currentContext: "rancher-cluster-proxy-ctx"
  });
  return {
    k8s,
    kc,
    coreV1: kc.makeApiClient(k8s.CoreV1Api),
    authorizationV1: kc.makeApiClient(k8s.AuthorizationV1Api)
  };
}

module.exports = { buildKubeConfig };
