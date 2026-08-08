"use strict";

const core = require("../dbtunnel-core");
const { buildKubeConfig } = require("./kubeconfig-proxy");

async function openTunnel(ctx, { dbHost, dbPort, avoidNodeHostnames, requireNodeHostnames }) {
  const { kc, coreV1 } = await buildKubeConfig(ctx);
  return core.openTunnel({
    coreV1,
    kc,
    namespace: ctx.namespace,
    domain: ctx.domain,
    dbHost,
    dbPort,
    avoidNodeHostnames,
    requireNodeHostnames
  });
}

async function openTunnelViaExec(ctx, { podName, dbHost, dbPort }) {
  const { kc, coreV1 } = await buildKubeConfig(ctx);
  return core.openTunnelViaExec({
    coreV1,
    kc,
    namespace: ctx.namespace,
    podName,
    dbHost,
    dbPort
  });
}

async function closeTunnelServer(server) {
  return core.closeTunnelServer(server);
}

async function deleteJumpPod(ctx) {
  const { coreV1 } = await buildKubeConfig(ctx);
  return core.deleteJumpPod({ coreV1, namespace: ctx.namespace, domain: ctx.domain });
}

module.exports = { openTunnel, openTunnelViaExec, closeTunnelServer, deleteJumpPod };
