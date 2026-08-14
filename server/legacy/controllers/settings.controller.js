"use strict";

const settingsService = require("../services/settings.service");
const dbService = require("../services/db.service");
const { requireBodyFields } = require("../utils/validators");

async function getCurrentInstallInfo(_req, res, next) {
  try {
    const data = settingsService.getCurrentInstallInfo();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function applySettings(req, res, next) {
  try {
    // k8sql: KHÔNG có "installDir" nữa (Tauri không hỗ trợ relocate, xem CLAUDE.md mục "Việc KHÔNG
    // port") — chỉ còn "values" (secret token/connection string thật), ghi thẳng SQLite+keychain
    // qua settingsRepo.applySecretValues() thay vì spawn script bash/PowerShell như k8sctl gốc.
    const data = await settingsService.applySettings(req.body);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function browseDirectory(_req, res, next) {
  try {
    const data = settingsService.browseDirectory();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function listRancherClusters(_req, res, next) {
  try {
    const data = settingsService.listRancherClusters();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function listNamespaceGroups(_req, res, next) {
  try {
    const data = settingsService.listNamespaceGroups();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function saveNamespaceGroups(req, res, next) {
  try {
    requireBodyFields(req.body, ["groups"]);
    const data = await settingsService.saveNamespaceGroups(req.body.groups);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function saveRancherClusters(req, res, next) {
  try {
    requireBodyFields(req.body, ["clusters"]);
    const data = await settingsService.saveRancherClusters(req.body.clusters);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

// Icon con mắt "xem giá trị thật" (popup Cấu hình) — POST thay vì GET (name không nên nằm trên
// URL/log, cùng lý do listRancherClusterOptions dùng POST). Chỉ gọi khi user chủ động bấm xem.
async function revealRancherToken(req, res, next) {
  try {
    requireBodyFields(req.body, ["name"]);
    const data = settingsService.revealRancherToken(req.body.name);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function listRancherProjects(req, res, next) {
  try {
    const data = await settingsService.listRancherProjects(req.query.rancherKey);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function listRancherNamespaces(req, res, next) {
  try {
    const data = await settingsService.listRancherNamespaces(req.query.rancherKey, req.query.projectId);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function listRancherServices(req, res, next) {
  try {
    const data = await settingsService.listRancherServices(
      req.query.rancherKey,
      req.query.projectId,
      req.query.namespace
    );
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function listRancherDeployments(req, res, next) {
  try {
    const data = await settingsService.listRancherDeployments(
      req.query.rancherKey,
      req.query.projectId,
      req.query.namespace
    );
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function listRancherClusterOptions(req, res, next) {
  try {
    requireBodyFields(req.body, ["rancherUrl", "token"]);
    const data = await settingsService.listRancherClusterOptions(req.body);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

// 3 handler dưới đây — bản ad-hoc của listRancherProjects/Namespaces/Services (cùng lý do
// listRancherClusterOptions dùng POST thay vì query string: token không nên nằm trong URL/log).
// Dùng khi cluster chưa "Áp dụng" (chưa có trong config/rancher-clusters.json), xem
// public/shared/settings-modal.js::fetchCascade().
async function listRancherProjectsAdhoc(req, res, next) {
  try {
    requireBodyFields(req.body, ["rancherUrl", "token", "clusterId"]);
    const { rancherUrl, token, clusterId, insecureTLS } = req.body;
    const data = await settingsService.listRancherProjects(null, { rancherUrl, token, clusterId, insecureTLS });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function listRancherNamespacesAdhoc(req, res, next) {
  try {
    requireBodyFields(req.body, ["rancherUrl", "token", "clusterId", "projectId"]);
    const { rancherUrl, token, clusterId, insecureTLS, projectId } = req.body;
    const data = await settingsService.listRancherNamespaces(null, projectId, { rancherUrl, token, clusterId, insecureTLS });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function listRancherServicesAdhoc(req, res, next) {
  try {
    requireBodyFields(req.body, ["rancherUrl", "token", "clusterId", "projectId", "namespace"]);
    const { rancherUrl, token, clusterId, insecureTLS, projectId, namespace } = req.body;
    const data = await settingsService.listRancherServices(null, projectId, namespace, {
      rancherUrl,
      token,
      clusterId,
      insecureTLS
    });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function listDbEnvironments(_req, res, next) {
  try {
    const data = settingsService.listDbEnvironments();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function saveDbEnvironments(req, res, next) {
  try {
    requireBodyFields(req.body, ["environments"]);
    const data = await settingsService.saveDbEnvironments(req.body.environments);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

// Icon con mắt "xem giá trị thật" cho Connection String (Settings UI) — cùng lý do dùng POST như
// revealRancherToken() ở trên.
async function revealDbEnvironmentValue(req, res, next) {
  try {
    requireBodyFields(req.body, ["name"]);
    const data = settingsService.revealDbEnvironmentValue(req.body.name);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

// Icon "Kiểm tra kết nối" trong bảng Connection String (Settings UI) — chỉ nhận "name" (envName đã
// lưu trong config/db-environments.json), không nhận connection string thô vì db.service.js đọc
// thẳng config đã lưu trên đĩa, xem services/db.service.js::testConnection().
async function testDbConnection(req, res, next) {
  try {
    requireBodyFields(req.body, ["name"]);
    const data = await dbService.testConnection(req.body.name);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

// Bản ad-hoc của testDbConnection — nhận thẳng connectionString (+ thông tin tunnel nếu có) từ 1
// dòng CHƯA "Áp dụng" trên Settings UI, không cần "name" đã lưu trong config/db-environments.json.
// Xem services/db.service.js::testConnectionAdhoc().
async function testDbConnectionAdhoc(req, res, next) {
  try {
    requireBodyFields(req.body, ["connectionString"]);
    const data = await dbService.testConnectionAdhoc(req.body);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getCurrentInstallInfo,
  applySettings,
  browseDirectory,
  listRancherClusters,
  saveRancherClusters,
  revealRancherToken,
  listRancherProjects,
  listRancherNamespaces,
  listRancherServices,
  listRancherDeployments,
  listRancherClusterOptions,
  listRancherProjectsAdhoc,
  listRancherNamespacesAdhoc,
  listRancherServicesAdhoc,
  listDbEnvironments,
  saveDbEnvironments,
  revealDbEnvironmentValue,
  testDbConnection,
  testDbConnectionAdhoc,
  listNamespaceGroups,
  saveNamespaceGroups
};
