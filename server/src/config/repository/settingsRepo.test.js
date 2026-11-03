"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const dbModule = require("../db.ts");

test("updates only the unchanged environment's selected pod and preserves recovery during a stale Settings save", async (context) => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE rancher_clusters (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE db_environments (id INTEGER PRIMARY KEY, name TEXT, description TEXT, mode TEXT, domain TEXT,
      existing_pod_name TEXT, namespace TEXT, db_host TEXT, db_port INTEGER, project_id TEXT, engine TEXT,
      rancher_cluster_id INTEGER, allow_write INTEGER, secret_ref TEXT, updated_at TEXT);
    INSERT INTO rancher_clusters VALUES (1, 'cluster');
    INSERT INTO db_environments VALUES (1, 'env', '', 'k8s-tunnel', NULL, 'old', 'ns', 'db', 5432, 'project', 'postgres', 1, 0, 'env-secret', NULL);
    INSERT INTO db_environments VALUES (2, 'other', '', 'k8s-tunnel', NULL, 'old', 'ns', 'db', 5432, 'project', 'postgres', 1, 0, 'other-secret', NULL);`);
  context.mock.method(dbModule, "getDb", () => db);
  const repo = require("./settingsRepo.ts");
  const expected = { name: "env", mode: "k8s-tunnel", existingPodName: "old", namespace: "ns", dbHost: "db", dbPort: 5432, projectId: "project", engine: "postgres", rancherKey: "cluster" };
  assert.equal(repo.replaceDbEnvironmentPod(expected, "new"), true);
  assert.equal(repo.replaceDbEnvironmentPod(expected, "later"), false);
  assert.equal(db.prepare("SELECT existing_pod_name FROM db_environments WHERE name = ?").get("env").existing_pod_name, "new");
  assert.equal(db.prepare("SELECT existing_pod_name FROM db_environments WHERE name = ?").get("other").existing_pod_name, "old");
  const other = { ...expected, name: "other" };
  await repo.upsertDbEnvironments([{ ...expected, expectedExistingPodName: "old" }, other]);
  assert.equal(db.prepare("SELECT existing_pod_name FROM db_environments WHERE name = ?").get("env").existing_pod_name, "new");
  await repo.upsertDbEnvironments([{ ...expected, existingPodName: "manual", expectedExistingPodName: "old" }, other]);
  assert.equal(db.prepare("SELECT existing_pod_name FROM db_environments WHERE name = ?").get("env").existing_pod_name, "manual");
  db.close();
});