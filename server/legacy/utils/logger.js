const fs = require("fs");
const path = require("path");

const logDirectory = path.resolve(__dirname, "..", "logs");
const logFilePath = path.join(logDirectory, "operations.log");

function ensureLogDirectory() {
  if (!fs.existsSync(logDirectory)) {
    fs.mkdirSync(logDirectory, { recursive: true });
  }
}

function logOperation(entry) {
  ensureLogDirectory();
  const payload = {
    timestamp: new Date().toISOString(),
    clusterName: entry.clusterName || null,
    namespace: entry.namespace || null,
    domain: entry.domain || null,
    resource: entry.resource || null,
    operation: entry.operation || null,
    success: Boolean(entry.success),
    error: entry.error || null,
    // Dùng bởi resource "sql" (db.service.js) — env (tên connection trong db-environments.json)
    // và rowCount, không liên quan k8s. Optional, không ảnh hưởng caller k8s hiện có.
    ...(entry.env !== undefined ? { env: entry.env } : {}),
    ...(entry.rowCount !== undefined ? { rowCount: entry.rowCount } : {}),
    // Dùng bởi "db-tunnel"/"open-exec" — tool relay TCP thật sự chọn được trong pod có sẵn
    // (socat/nc/bash), để chẩn đoán khi kết nối treo/lỗi mà không rõ nguyên nhân ở tầng nào.
    ...(entry.relayTool !== undefined ? { relayTool: entry.relayTool } : {})
  };
  fs.appendFileSync(logFilePath, `${JSON.stringify(payload)}\n`, "utf8");
}

module.exports = {
  logOperation
};
