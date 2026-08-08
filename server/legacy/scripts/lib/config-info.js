"use strict";

// Tách từ scripts/wizard.js — dùng chung bởi wizard cài đặt gốc VÀ endpoint "Cấu hình" live
// (services/settings.service.js), để cả 2 hiển thị ĐÚNG CÙNG 1 bộ thông tin (port, đã có
// token/connection string hay chưa, danh sách biến DB cần điền).
const fs = require("fs");
const path = require("path");

function readEnvFile(targetDir) {
  let content = "";
  try {
    content = fs.readFileSync(path.join(targetDir, ".env"), "utf8");
  } catch {
    return {};
  }
  const values = {};
  for (const line of content.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (match) {
      values[match[1]] = match[2];
    }
  }
  return values;
}

function dbEnvVarNames(targetDir) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(targetDir, "config", "db-environments.json"), "utf8"));
    return list.map((item) => item.connectionStringEnvVar).filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = { readEnvFile, dbEnvVarNames };
