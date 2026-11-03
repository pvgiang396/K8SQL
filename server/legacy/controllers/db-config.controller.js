"use strict";

const fs = require("fs");
const dbConfigService = require("../services/db-config.service");
const { encodeToSqliteBuffer, decodeFromSqliteBuffer } = require("../services/sql-config-codec");

// Export/import trả/nhận file .sqlite nhị phân (srs/nangcapk8sql/v1.md #2, đổi từ .json trước đây)
// — không dùng envelope { success, data } JSON như các route khác vì body là binary.
function sendSqlite(res, bundle, filename) {
  const buffer = encodeToSqliteBuffer(bundle);
  res.set("Content-Type", "application/octet-stream");
  res.set("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(buffer);
}

async function exportConfig(_req, res, next) {
  try {
    sendSqlite(res, dbConfigService.exportConfig(), "k8sql-config.sqlite");
  } catch (error) {
    next(error);
  }
}

async function exportSelection(req, res, next) {
  try {
    const { environmentNames, namespaceGroupNames } = req.body || {};
    sendSqlite(
      res,
      dbConfigService.exportSelection({ environmentNames, namespaceGroupNames }),
      "k8sql-config-selection.sqlite"
    );
  } catch (error) {
    next(error);
  }
}

async function importConfig(req, res, next) {
  try {
    const parsed = decodeFromSqliteBuffer(req.body);
    const data = await dbConfigService.importConfig(parsed);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

// Biến thể ghi/đọc thẳng qua đường dẫn đĩa (thay vì body HTTP) — dùng khi frontend chạy trong
// WebView Tauri, nơi window.showSaveFilePicker/showOpenFilePicker (File System Access API) không
// hoạt động đáng tin cậy trên WebKitGTK (promise treo vô thời hạn, không lỗi/không dialog — xem
// k8sql/CLAUDE.md). Path lấy từ tauri-plugin-dialog phía frontend, ghi/đọc file thật ngay tại đây
// vì sidecar Node có toàn quyền filesystem, không cần thêm plugin fs phía Tauri.
async function exportConfigToPath(req, res, next) {
  try {
    const { path: targetPath } = req.body || {};
    if (!targetPath) {
      res.status(400).json({ success: false, message: "Thiếu tham số path." });
      return;
    }
    const bundle = dbConfigService.exportConfig();
    fs.writeFileSync(targetPath, encodeToSqliteBuffer(bundle));
    res.json({
      success: true,
      data: {
        environmentsCount: bundle.environments.length,
        rancherClustersCount: bundle.rancherClusters.length,
        namespaceGroupsCount: bundle.namespaceGroups.length
      }
    });
  } catch (error) {
    next(error);
  }
}

async function importConfigFromPath(req, res, next) {
  try {
    const { path: sourcePath } = req.body || {};
    if (!sourcePath) {
      res.status(400).json({ success: false, message: "Thiếu tham số path." });
      return;
    }
    const buffer = fs.readFileSync(sourcePath);
    const parsed = decodeFromSqliteBuffer(buffer);
    const data = await dbConfigService.importConfig(parsed);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function exportSelectionToPath(req, res, next) {
  try {
    const { path: targetPath, environmentNames, namespaceGroupNames } = req.body || {};
    if (!targetPath) {
      res.status(400).json({ success: false, message: "Thiếu tham số path." });
      return;
    }
    const bundle = dbConfigService.exportSelection({ environmentNames, namespaceGroupNames });
    fs.writeFileSync(targetPath, encodeToSqliteBuffer(bundle));
    res.json({
      success: true,
      data: {
        environmentsCount: bundle.environments.length,
        rancherClustersCount: bundle.rancherClusters.length,
        namespaceGroupsCount: bundle.namespaceGroups.length
      }
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  exportConfig,
  exportSelection,
  importConfig,
  exportConfigToPath,
  exportSelectionToPath,
  importConfigFromPath
};
