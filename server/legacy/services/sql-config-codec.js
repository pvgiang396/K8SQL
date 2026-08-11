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

function encodeToSqliteBuffer(environments) {
  return withTempSqlitePath((tmpPath) => {
    const db = new DatabaseSync(tmpPath);
    try {
      db.exec("CREATE TABLE db_environments (name TEXT PRIMARY KEY, data TEXT NOT NULL)");
      const insert = db.prepare("INSERT INTO db_environments (name, data) VALUES (?, ?)");
      for (const env of environments) {
        insert.run(env.name, JSON.stringify(env));
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
    let rows;
    try {
      rows = db.prepare("SELECT data FROM db_environments").all();
    } finally {
      db.close();
    }
    return { environments: rows.map((row) => JSON.parse(row.data)) };
  });
}

module.exports = { encodeToSqliteBuffer, decodeFromSqliteBuffer };
