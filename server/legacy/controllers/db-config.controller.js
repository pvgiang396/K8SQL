"use strict";

const fs = require("fs");
const dbConfigService = require("../services/db-config.service");
const { encodeToSqliteBuffer, decodeFromSqliteBuffer } = require("../services/sql-config-codec");

// Export/import trả/nhận file .sqlite nhị phân (srs/nangcapk8sql/v1.md #2, đổi từ .json trước đây)
// — không dùng envelope { success, data } JSON như các route khác vì body là binary.
async function exportConfig(_req, res, next) {
  try {
    const { environments, rancherClusters } = dbConfigService.exportConfig();
    const buffer = encodeToSqliteBuffer({ environments, rancherClusters });
    res.set("Content-Type", "application/octet-stream");
    res.set("Content-Disposition", 'attachment; filename="k8sql-config.sqlite"');
    res.send(buffer);
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
    const { environments, rancherClusters } = dbConfigService.exportConfig();
    const buffer = encodeToSqliteBuffer({ environments, rancherClusters });
    fs.writeFileSync(targetPath, buffer);
    res.json({
      success: true,
      data: { environmentsCount: environments.length, rancherClustersCount: rancherClusters.length }
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

module.exports = {
  exportConfig,
  importConfig,
  exportConfigToPath,
  importConfigFromPath
};
