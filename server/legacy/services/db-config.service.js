"use strict";

const { AppError } = require("../utils/error");
const { selectExportBundle } = require("./sql-config-codec");
const { loadEnvironments, listEnvironmentsPublic } = require("./db-environment.service");
const settingsRepo = require("../../src/config/repository/settingsRepo.ts");
const {
  refreshProcessEnvSecrets,
  deriveTokenEnvVar,
  deriveConnStringEnvVar
} = require("../../src/secrets/envShim.ts");
const { migrateRancherClusterKeys } = require("../../src/migration/migrateRancherKeys.ts");

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
  const rancherClusters = settingsRepo.listRancherClusters();
  return {
    environments: environments.map((env) => ({
      ...env,
      connectionString: process.env[env.connectionStringEnvVar] || ""
    })),
    rancherClusters: rancherClusters.map((cluster) => ({
      ...cluster,
      token: process.env[cluster.tokenEnvVar] || ""
    })),
    namespaceGroups: settingsRepo.listNamespaceGroups()
  };
}

function exportSelection({ environmentNames, namespaceGroupNames }) {
  if (!Array.isArray(environmentNames) || !Array.isArray(namespaceGroupNames)) {
    throw new AppError('"environmentNames" và "namespaceGroupNames" phải là mảng.', 400);
  }
  const bundle = selectExportBundle(exportConfig(), { environmentNames, namespaceGroupNames });
  if (!bundle.environments.length && !bundle.namespaceGroups.length) {
    throw new AppError("Không có connection hoặc nhóm namespace nào khớp lựa chọn.", 400);
  }
  return bundle;
}

// environments/rancherClusters: mỗi entry tự chứa secret thật ("connectionString"/"token", xem
// exportConfig()) — ghi qua settingsRepo (SQLite + keychain) rồi refreshProcessEnvSecrets() để
// process.env đọc được ngay (không còn ghi file .json/.env trung gian nào nữa, xem envShim.ts).
//
// Merge theo "name" (ghi đè entry trùng tên, GIỮ NGUYÊN entry cũ không có trong file import) — cố ý
// KHÁC ngữ nghĩa "replace-all" của settingsRepo.upsertRancherClusters()/upsertDbEnvironments() (dùng
// cho nút "Áp dụng" toàn bộ danh sách của Settings UI): import chỉ nên BỔ SUNG, không được xoá mất
// cấu hình khác người nhận đã tự thêm trước đó.
async function importConfig({ environments, rancherClusters, namespaceGroups }) {
  if (!Array.isArray(environments)) {
    throw new AppError('Body phải có field "environments" là 1 mảng.', 400);
  }
  const hasGroups = Array.isArray(namespaceGroups) && namespaceGroups.length > 0;
  const hasClusters = Array.isArray(rancherClusters) && rancherClusters.length > 0;
  if (environments.length === 0 && !hasGroups && !hasClusters) {
    throw new AppError("File không có dữ liệu để import.", 400);
  }
  if (environments.some((item) => !item || typeof item.name !== "string" || !item.name)) {
    throw new AppError('Mỗi phần tử "environments" phải có field "name".', 400);
  }
  if (environments.some((item) => item.connectionString !== undefined && !item.connectionStringEnvVar)) {
    throw new AppError('Entry có "connectionString" bắt buộc phải có "connectionStringEnvVar" đi kèm.', 400);
  }
  if (rancherClusters !== undefined && !Array.isArray(rancherClusters)) {
    throw new AppError('"rancherClusters" phải là 1 mảng.', 400);
  }
  if ((rancherClusters || []).some((item) => !item || typeof item.name !== "string" || !item.name)) {
    throw new AppError('Mỗi phần tử "rancherClusters" phải có field "name".', 400);
  }
  if (namespaceGroups !== undefined && !Array.isArray(namespaceGroups)) {
    throw new AppError('"namespaceGroups" phải là 1 mảng.', 400);
  }
  if ((namespaceGroups || []).some((item) => !item || typeof item.name !== "string" || !item.name)) {
    throw new AppError('Mỗi phần tử "namespaceGroups" phải có field "name".', 400);
  }

  const secrets = {};

  const currentClusters = settingsRepo.listRancherClusters();
  const mergedClusters = [...currentClusters];
  const rancherClustersImported = [];
  for (const incoming of rancherClusters || []) {
    const { token, tokenEnvVar, ...structural } = incoming;
    if (token) {
      secrets[deriveTokenEnvVar(structural.name)] = token;
    }
    const index = mergedClusters.findIndex((item) => item.name === structural.name);
    if (index >= 0) {
      mergedClusters[index] = { ...mergedClusters[index], ...structural };
    } else {
      mergedClusters.push(structural);
    }
    rancherClustersImported.push(structural.name);
  }

  const currentEnvironments = loadEnvironments();
  const mergedEnvironments = [...currentEnvironments];
  const dbEnvironmentsImported = [];
  for (const incoming of environments) {
    const { connectionString, ...structural } = incoming;
    if (connectionString !== undefined) {
      secrets[deriveConnStringEnvVar(structural.name)] = connectionString;
    }
    const index = mergedEnvironments.findIndex((item) => item.name === structural.name);
    if (index >= 0) {
      mergedEnvironments[index] = { ...mergedEnvironments[index], ...structural };
    } else {
      mergedEnvironments.push(structural);
    }
    dbEnvironmentsImported.push(structural.name);
  }

  const namespaceGroupsImported = [];
  let mergedGroups = null;
  if (Array.isArray(namespaceGroups)) {
    mergedGroups = [...settingsRepo.listNamespaceGroups()];
    for (const incoming of namespaceGroups) {
      const index = mergedGroups.findIndex((item) => item.name === incoming.name);
      if (index >= 0) mergedGroups[index] = { ...mergedGroups[index], ...incoming };
      else mergedGroups.push(incoming);
      namespaceGroupsImported.push(incoming.name);
    }
  }

  // Cluster PHẢI ghi trước — db_environments và namespace_groups FK vào rancher_clusters qua tên.
  await settingsRepo.upsertRancherClusters(mergedClusters);
  await settingsRepo.upsertDbEnvironments(mergedEnvironments);
  if (mergedGroups) await settingsRepo.upsertNamespaceGroups(mergedGroups);
  if (Object.keys(secrets).length > 0) {
    await settingsRepo.applySecretValues(secrets);
  }
  await migrateRancherClusterKeys();
  await refreshProcessEnvSecrets();

  return {
    environments: listEnvironmentsPublic(),
    rancherClustersImported,
    dbEnvironmentsImported,
    namespaceGroupsImported
  };
}

module.exports = {
  exportConfig,
  exportSelection,
  importConfig
};
