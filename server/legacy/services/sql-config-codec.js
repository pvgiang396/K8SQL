"use strict";

// Encode/decode dữ liệu export/import "Cấu hình kết nối" (xem db-config.service.js) sang định dạng
// file .sqlite thay vì .json trước đây (srs/nangcapk8sql/v1.md #2) — chỉ đổi lớp đóng gói ở biên,
// KHÔNG đụng logic validate/ghi .env/config trong exportConfig()/importConfig().
//
// Bảng chỉ có 1 cột "data" chứa JSON-encode NGUYÊN VẸN từng entry (kể cả field "connectionString"
// thật) thay vì tách cột cứng theo từng field — entry hiện có shape khác nhau tuỳ engine
// (sql/mongo), tách cột cứng dễ rớt field khi loadEnvironments() đổi shape sau này.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

function withTempSqlitePath(fn) {
  const tmpPath = path.join(os.tmpdir(), `k8sql-config-${crypto.randomUUID()}.sqlite`);
  try {
    return fn(tmpPath);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}

// rancher_clusters — bảng thứ 2, cùng pattern (name TEXT PRIMARY KEY, data TEXT JSON) — thêm
// 2026-08-14 vì file export trước đó chỉ mang db_environments, khiến entry mode "k8s-tunnel" tham
// chiếu 1 rancherKey không tồn tại trên máy đích (lỗi "Rancher cluster not found in
// rancher-clusters.json", xem srs/LoiImportK8sql/mota.md). `data` mang cả field "token" thật —
// nhất quán với "connectionString" thật trong db_environments (đánh đổi bảo mật đã chấp nhận, xem
// db-config.service.js).
function encodeToSqliteBuffer({ environments, rancherClusters }) {
  return withTempSqlitePath((tmpPath) => {
    const db = new DatabaseSync(tmpPath);
    try {
      db.exec("CREATE TABLE db_environments (name TEXT PRIMARY KEY, data TEXT NOT NULL)");
      const insertEnv = db.prepare("INSERT INTO db_environments (name, data) VALUES (?, ?)");
      for (const env of environments) {
        insertEnv.run(env.name, JSON.stringify(env));
      }

      db.exec("CREATE TABLE rancher_clusters (name TEXT PRIMARY KEY, data TEXT NOT NULL)");
      const insertCluster = db.prepare("INSERT INTO rancher_clusters (name, data) VALUES (?, ?)");
      for (const cluster of rancherClusters || []) {
        insertCluster.run(cluster.name, JSON.stringify(cluster));
      }
    } finally {
      db.close();
    }
    return fs.readFileSync(tmpPath);
  });
}

function decodeFromSqliteBuffer(buffer) {
  return withTempSqlitePath((tmpPath) => {
    fs.writeFileSync(tmpPath, buffer);
    const db = new DatabaseSync(tmpPath, { readOnly: true });
    let envRows;
    let clusterRows;
    try {
      envRows = db.prepare("SELECT data FROM db_environments").all();
      // File export cũ (trước 2026-08-14) không có bảng này — coi như rỗng thay vì lỗi, để vẫn
      // import được file cũ (chỉ thiếu Rancher cluster, không phải lỗi).
      try {
        clusterRows = db.prepare("SELECT data FROM rancher_clusters").all();
      } catch {
        clusterRows = [];
      }
    } finally {
      db.close();
    }
    return {
      environments: envRows.map((row) => JSON.parse(row.data)),
      rancherClusters: clusterRows.map((row) => JSON.parse(row.data))
    };
  });
}

module.exports = { encodeToSqliteBuffer, decodeFromSqliteBuffer };
