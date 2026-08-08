"use strict";

const core = require("../dbtunnel-core");

async function openTunnel(ctx, { dbHost, dbPort, avoidNodeHostnames, requireNodeHostnames }) {
  return core.openTunnel({
    coreV1: ctx.coreV1,
    kc: ctx.kc,
    namespace: ctx.namespace,
    domain: ctx.domain,
    dbHost,
    dbPort,
    avoidNodeHostnames,
    requireNodeHostnames
  });
}

async function closeTunnelServer(server) {
  return core.closeTunnelServer(server);
}

async function deleteJumpPod(ctx) {
  return core.deleteJumpPod({ coreV1: ctx.coreV1, namespace: ctx.namespace, domain: ctx.domain });
}

module.exports = { openTunnel, closeTunnelServer, deleteJumpPod };
