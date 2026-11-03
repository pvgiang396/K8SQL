"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const pg = require("pg");
const mongodb = require("mongodb");
const kube = require("../services/kube.service");
const permissions = require("../services/permissions.service");
const rancher = require("../services/providers/rancher/dbtunnel");
const logger = require("../utils/logger");
const podService = require("../services/pod.service");
const environmentService = require("../services/db-environment.service");
const settingsRepo = require("../../src/config/repository/settingsRepo.ts");
const { errorMiddleware } = require("../utils/error");

test("Object Explorer loads PostgreSQL and MongoDB after replacing a missing pod", async (context) => {
  const environments = new Map();
  const saved = [];
  context.mock.method(kube, "buildRancherContext", async () => ({ provider: "rancher", namespace: "test" }));
  context.mock.method(permissions, "checkAccessForCtx", async () => ({ writeAccess: true }));
  context.mock.method(logger, "logOperation", () => {});
  context.mock.method(environmentService, "getEnvironmentOrThrow", (name) => ({ ...environments.get(name) }));
  context.mock.method(environmentService, "detectEngine", (env) => env.engine);
  context.mock.method(podService, "listPodsForDbEnv", async () => [{ name: "bad" }, { name: "good" }]);
  context.mock.method(settingsRepo, "replaceDbEnvironmentPod", (env, name) => {
    saved.push([env.name, name]);
    environments.get(env.name).existingPodName = name;
    return true;
  });
  let nextPort = 10000;
  context.mock.method(rancher, "openTunnelViaExec", async (_ctx, options) => {
    if (options.podName === "missing") throw Object.assign(new Error("pod not found"), { code: 404 });
    if (options.podName === "bad") throw new Error("relay unavailable");
    return { podName: options.podName, localPort: ++nextPort, server: { close() {} } };
  });
  context.mock.method(rancher, "closeTunnelServer", async (server) => server.close());
  const originalPool = pg.Pool;
  pg.Pool = class {
    async connect() {
      return { query: async () => ({ rows: [{ schema_name: "public", __k8sctl_total_count: 1 }] }), release() {} };
    }
    async end() {}
  };
  context.after(() => { pg.Pool = originalPool; });
  context.mock.method(mongodb.MongoClient.prototype, "connect", async () => {});
  context.mock.method(mongodb.MongoClient.prototype, "db", () => ({ admin: () => ({ listDatabases: async () => ({ databases: [{ name: "emc" }] }) }) }));
  context.mock.method(mongodb.MongoClient.prototype, "close", async () => {});
  assert.equal(require.cache[require.resolve("../services/providers/postgres/query")], undefined);
  const postgres = require("../services/providers/postgres/query");
  const mongo = require("../services/providers/mongo/query");
  context.mock.method(postgres, "pingAdhoc", async () => {});
  context.mock.method(mongo, "pingAdhoc", async () => {});
  const controller = require("./db-schema.controller");
  const app = express();
  app.get("/sql/schemas", controller.listSchemas);
  app.use(errorMiddleware);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  for (const [engine, connectionString, expected] of [
    ["postgres", "postgres://user:pass@__HOST__/test", "public"],
    ["mongo", "mongodb://user:pass@__HOST__/test", "emc"]
  ]) {
    const name = `explorer-${engine}`;
    const connectionStringEnvVar = `TEST_EXPLORER_${engine.toUpperCase()}`;
    process.env[connectionStringEnvVar] = connectionString;
    context.after(() => { delete process.env[connectionStringEnvVar]; });
    environments.set(name, { name, engine, mode: "k8s-tunnel", rancherKey: "test", namespace: "test", projectId: "project", existingPodName: "missing", connectionStringEnvVar });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/sql/schemas?env=${name}`);
    const body = await response.json();
    assert.equal(response.status, 200, `${engine}: ${body.message || "unexpected response"}`);
    assert.deepEqual(body.data.rows, [expected]);
    assert.equal(environments.get(name).existingPodName, "good");
  }
  assert.deepEqual(saved, [["explorer-postgres", "good"], ["explorer-mongo", "good"]]);
});