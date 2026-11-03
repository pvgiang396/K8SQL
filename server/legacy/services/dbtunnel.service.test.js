"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const kube = require("./kube.service");
const permissions = require("./permissions.service");
const rancher = require("./providers/rancher/dbtunnel");
const logger = require("../utils/logger");
const podService = require("./pod.service");
const environmentService = require("./db-environment.service");
const settingsRepo = require("../../src/config/repository/settingsRepo.ts");

test("tests pods before saving and recovers a cached exec tunnel without duplicate opens", async (context) => {
  context.mock.method(kube, "buildRancherContext", async () => ({ provider: "rancher", namespace: "test" }));
  context.mock.method(logger, "logOperation", () => {});
  context.mock.method(permissions, "checkAccessForCtx", async () => ({ writeAccess: true }));
  context.mock.method(environmentService, "detectEngine", (env) => env.engine || "postgres");
  context.mock.method(podService, "listPodsForDbEnv", async () => [{ name: "bad" }, { name: "good" }]);
  const saved = [];
  let allowSave = true;
  context.mock.method(settingsRepo, "replaceDbEnvironmentPod", (env, name) => { if (!allowSave) return false; saved.push([env.existingPodName, name]); return true; });
  let brokenPort;
  let failAll = false;
  const servers = [];
  const postgres = require("./providers/postgres/query");
  context.mock.method(postgres, "pingAdhoc", async (url) => {
    if (failAll || url.includes(`:${brokenPort}/`) || servers.some((server) => server.pod === "bad" && url.includes(`:${server.port}/`))) throw new Error("connection failed");
  });
  context.mock.method(rancher, "openTunnelViaExec", async (_ctx, options) => {
    if (options.podName === "missing") throw Object.assign(new Error("pod not found"), { code: 404 });
    const server = { closed: false, pod: options.podName, port: 10001 + servers.length, close() { this.closed = true; } };
    servers.push(server);
    return { server, localPort: 10000 + servers.length, podName: options.podName };
  });
  context.mock.method(rancher, "closeTunnelServer", async (server) => server.close());
  const service = require("./dbtunnel.service");
  process.env.TEST_TUNNEL_URL = "postgres://user:pass@__HOST__/test";
  context.after(() => { delete process.env.TEST_TUNNEL_URL; });
  const env = { name: "test-cache", rancherKey: "test", namespace: "test", existingPodName: "pod-old", connectionStringEnvVar: "TEST_TUNNEL_URL" };
  assert.equal((await service.openTunnelForDbEnv(env)).localPort, 10001);
  assert.equal((await service.openTunnelForDbEnv(env)).localPort, 10001);
  brokenPort = 10001;
  const reopened = await Promise.all([service.openTunnelForDbEnv(env), service.openTunnelForDbEnv(env)]);
  assert.deepEqual(reopened.map((result) => result.localPort), [10003, 10003]);
  assert.equal(servers.length, 3);
  assert.equal(servers[0].closed, true);
  assert.equal(servers[1].closed, true);
  assert.deepEqual(saved, [["pod-old", "good"]]);
  await service.closeTunnelForDbEnv(env.name);

  failAll = true;
  const unavailable = { ...env, name: "unavailable", existingPodName: "old" };
  await assert.rejects(service.openTunnelForDbEnv(unavailable), /Không tìm thấy pod khả dụng/);
  assert.deepEqual(saved, [["pod-old", "good"]]);

  failAll = false;
  allowSave = false;
  brokenPort = 10007;
  const changed = { ...env, name: "changed", existingPodName: "old" };
  await assert.rejects(service.openTunnelForDbEnv(changed), (error) => error.statusCode === 409);
  assert.deepEqual(saved, [["pod-old", "good"]]);

  const mongo = require("./providers/mongo/query");
  let mongoPings = 0;
  context.mock.method(mongo, "pingAdhoc", async () => { mongoPings += 1; });
  const mongoEnv = { ...env, name: "mongo", engine: "mongo", existingPodName: "mongo-pod" };
  await service.openTunnelForDbEnv(mongoEnv);
  assert.equal(mongoPings, 1);
  await service.closeTunnelForDbEnv(mongoEnv.name);

  allowSave = true;
  const missing = { ...env, name: "missing-pod", existingPodName: "missing" };
  await service.openTunnelForDbEnv(missing);
  assert.deepEqual(saved.at(-1), ["missing", "good"]);
  await service.closeTunnelForDbEnv(missing.name);
});