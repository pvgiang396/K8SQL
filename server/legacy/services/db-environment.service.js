"use strict";

const fs = require("fs");
const path = require("path");
const { AppError } = require("../utils/error");
const { getBaseDir } = require("../utils/base-dir");

const CONFIG_PATH = path.join(getBaseDir(), "config", "db-environments.json");

function loadEnvironments() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf8");
  } catch (error) {
    throw new AppError(`Không đọc được config/db-environments.json: ${error.message}`, 500);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AppError(`config/db-environments.json không phải JSON hợp lệ: ${error.message}`, 500);
  }

  if (!Array.isArray(parsed)) {
    throw new AppError("config/db-environments.json phải là 1 mảng.", 500);
  }
  return parsed;
}

// Ghi thẳng field "mongoDriver" ("modern"/"legacy") vào đúng entry theo name — dùng khi
// providers/mongo/query.js tự phát hiện server MongoDB quá cũ (wire version thấp hơn driver 6.x
// yêu cầu) và fallback sang driver mongodb@3.x, để lần kết nối sau không cần thử lại driver mới
// trước (tránh timeout serverSelectionTimeoutMS mỗi lần). Không dùng saveDbEnvironments() ở
// settings.service.js vì hàm đó ghi ĐÈ TOÀN BỘ mảng (dùng cho UI Settings) — ở đây chỉ cần sửa 1
// field của đúng 1 entry, giữ nguyên mọi entry khác byte-for-byte không cần thiết.
function setMongoDriverPreference(name, mongoDriver) {
  const environments = loadEnvironments();
  const index = environments.findIndex((item) => item.name === name);
  if (index === -1) return;
  if (environments[index].mongoDriver === mongoDriver) return;
  environments[index] = { ...environments[index], mongoDriver };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(environments, null, 2) + "\n", "utf8");
}

function getEnvironmentOrThrow(name) {
  const environments = loadEnvironments();
  const env = environments.find((item) => item.name === name);
  if (!env) {
    throw new AppError(
      `Environment "${name}" không tồn tại trong config/db-environments.json. Hợp lệ: ${environments
        .map((item) => item.name)
        .join(", ")}`,
      404
    );
  }
  return env;
}

// Tự phát hiện engine Postgres/Mongo qua scheme của connection string — cho phép override tường
// minh bằng field "engine" trong config/db-environments.json khi cần (proxy/scheme không chuẩn).
// Đọc THẲNG biến môi trường (không qua resolveConnectionString/mở tunnel) — kể cả mode "k8s-tunnel"
// vẫn còn nguyên scheme thật ở đầu chuỗi TEMPLATE (chỉ phần host bị thay bằng placeholder
// "__HOST__"), nên không cần mở tunnel chỉ để biết engine.
function detectEngine(env) {
  if (env.engine === "postgres" || env.engine === "mongo") {
    return env.engine;
  }
  const template = String(process.env[env.connectionStringEnvVar] || "").trim();
  return /^mongodb(\+srv)?:\/\//i.test(template) ? "mongo" : "postgres";
}

// Không bao giờ trả connectionStringEnvVar/giá trị thật ra API — chỉ tên + mô tả + allowWrite +
// engine (không phải secret, cần thiết để frontend biết môi trường nào cho phép ghi/thuộc engine
// nào để hiện đúng icon + hành vi Object Explorer/kết quả).
function listEnvironmentsPublic() {
  return loadEnvironments().map((env) => ({
    name: env.name,
    description: env.description,
    allowWrite: Boolean(env.allowWrite),
    engine: detectEngine(env)
  }));
}

module.exports = {
  loadEnvironments,
  getEnvironmentOrThrow,
  detectEngine,
  listEnvironmentsPublic,
  setMongoDriverPreference
};
