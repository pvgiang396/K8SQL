"use strict";

const { AppError } = require("../utils/error");
const settingsRepo = require("../../src/config/repository/settingsRepo.ts");

// Đọc thẳng SQLite qua settingsRepo (KHÔNG còn qua config/db-environments.json, xem
// k8sql/CLAUDE.md mục "Đọc thẳng SQLite lúc runtime") — bảng luôn tồn tại (tạo lúc getDb() init)
// nên rỗng là trạng thái hợp lệ (chưa khai báo gì), không throw như khi file thiếu/hỏng trước đây.
function loadEnvironments() {
  return settingsRepo.listDbEnvironments();
}

// Ghi thẳng field "mongoDriver" ("modern"/"legacy") vào đúng entry theo name — dùng khi
// providers/mongo/query.js tự phát hiện server MongoDB quá cũ (wire version thấp hơn driver 6.x
// yêu cầu) và fallback sang driver mongodb@3.x, để lần kết nối sau không cần thử lại driver mới
// trước (tránh timeout serverSelectionTimeoutMS mỗi lần). Không dùng saveDbEnvironments() ở
// settings.service.js vì hàm đó ghi ĐÈ TOÀN BỘ mảng (dùng cho UI Settings) — ở đây chỉ cần sửa 1
// field của đúng 1 entry, ghi trực tiếp qua settingsRepo.setDbEnvironmentMongoDriver().
function setMongoDriverPreference(name, mongoDriver) {
  const environments = loadEnvironments();
  const found = environments.find((item) => item.name === name);
  if (!found || found.mongoDriver === mongoDriver) return;
  settingsRepo.setDbEnvironmentMongoDriver(name, mongoDriver);
}

function getEnvironmentOrThrow(name) {
  const environments = loadEnvironments();
  const env = environments.find((item) => item.name === name);
  if (!env) {
    throw new AppError(
      `Environment "${name}" không tồn tại. Hợp lệ: ${environments.map((item) => item.name).join(", ")}`,
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
