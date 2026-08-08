"use strict";

const fs = require("fs");
const path = require("path");
const { AppError } = require("../utils/error");
const { loadEnvironments, listEnvironmentsPublic } = require("./db-environment.service");
const { getBaseDir } = require("../utils/base-dir");

const CONFIG_PATH = path.join(getBaseDir(), "config", "db-environments.json");
const ENV_FILE_PATH = path.join(getBaseDir(), ".env");

// LƯU Ý BẢO MẬT: exportConfig()/importConfig() là bề mặt API DUY NHẤT trả/nhận credential Postgres
// THẬT — mọi endpoint /sql/* khác (đặc biệt listEnvironmentsPublic()) cố tình không bao giờ lộ
// connectionStringEnvVar/giá trị thật. Chấp nhận đánh đổi này có chủ đích (mục đích: "share cấu
// hình dùng ngay được" cho người khác) — xem k8sctl/CLAUDE.md mục "SQL Tool".
//
// Mỗi entry trả về mang LUÔN field "connectionString" (giá trị thật) ngay cạnh các field cấu trúc —
// KHÔNG tách riêng thành 1 map "secrets" đối chiếu qua connectionStringEnvVar như thiết kế ban đầu:
// người nhận file export chỉ cần mở file là thấy ngay giá trị thật của đúng environment đó, không
// phải tự đối chiếu 2 cấu trúc rồi mới hiểu được (điểm user phản hồi thấy khó dùng khi thử share
// file thật).
function exportConfig() {
  const environments = loadEnvironments();
  return {
    environments: environments.map((env) => ({
      ...env,
      connectionString: process.env[env.connectionStringEnvVar] || ""
    }))
  };
}

// Đọc .env hiện tại theo dòng, thay giá trị cho key đã có, append dòng mới cho key chưa có —
// KHÔNG động tới các dòng/biến khác (Rancher token, PORT...).
function upsertEnvFile(updates) {
  let content = "";
  try {
    content = fs.readFileSync(ENV_FILE_PATH, "utf8");
  } catch {
    content = "";
  }

  const lines = content.split("\n");
  const seen = new Set();
  const newLines = lines.map((line) => {
    const match = line.match(/^([A-Za-z0-9_]+)=/);
    if (match && Object.prototype.hasOwnProperty.call(updates, match[1])) {
      seen.add(match[1]);
      return `${match[1]}=${updates[match[1]]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) {
      newLines.push(`${key}=${value}`);
    }
  }

  // Bỏ dòng rỗng thừa ở cuối file (append lặp lại nhiều lần không làm .env phình dòng trắng).
  while (newLines.length > 0 && newLines[newLines.length - 1] === "") {
    newLines.pop();
  }

  fs.writeFileSync(ENV_FILE_PATH, newLines.join("\n") + "\n", "utf8");
}

// environments: mảng entry tự chứa "connectionString" (xem exportConfig()) — tách field này ra
// trước khi ghi vào db-environments.json (file đó chỉ chứa cấu trúc, KHÔNG chứa secret), giá trị
// thật ghi riêng vào .env theo đúng "connectionStringEnvVar" của từng entry.
function importConfig({ environments }) {
  if (!Array.isArray(environments) || environments.length === 0) {
    throw new AppError('Body phải có field "environments" là 1 mảng không rỗng.', 400);
  }
  if (environments.some((item) => !item || typeof item.name !== "string" || !item.name)) {
    throw new AppError('Mỗi phần tử "environments" phải có field "name".', 400);
  }
  if (environments.some((item) => item.connectionString !== undefined && !item.connectionStringEnvVar)) {
    throw new AppError('Entry có "connectionString" bắt buộc phải có "connectionStringEnvVar" đi kèm.', 400);
  }

  const secrets = {};
  const structuralEntries = environments.map((incoming) => {
    const { connectionString, ...structural } = incoming;
    if (connectionString !== undefined) {
      secrets[structural.connectionStringEnvVar] = connectionString;
    }
    return structural;
  });

  const current = loadEnvironments();
  for (const incoming of structuralEntries) {
    const index = current.findIndex((item) => item.name === incoming.name);
    if (index >= 0) {
      current[index] = incoming;
    } else {
      current.push(incoming);
    }
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2) + "\n", "utf8");

  if (Object.keys(secrets).length > 0) {
    upsertEnvFile(secrets);
    // .env chỉ được dotenv.config() đọc 1 lần lúc khởi động — set lại process.env ngay để giá trị
    // mới import dùng được luôn, không cần restart server.
    for (const [key, value] of Object.entries(secrets)) {
      process.env[key] = value;
    }
  }

  return listEnvironmentsPublic();
}

module.exports = {
  exportConfig,
  importConfig
};
