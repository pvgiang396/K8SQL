"use strict";

const dbConfigService = require("../services/db-config.service");
const { encodeToSqliteBuffer, decodeFromSqliteBuffer } = require("../services/sql-config-codec");

// Export/import trả/nhận file .sqlite nhị phân (srs/nangcapk8sql/v1.md #2, đổi từ .json trước đây)
// — không dùng envelope { success, data } JSON như các route khác vì body là binary.
async function exportConfig(_req, res, next) {
  try {
    const { environments } = dbConfigService.exportConfig();
    const buffer = encodeToSqliteBuffer(environments);
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
    const data = dbConfigService.importConfig(parsed);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  exportConfig,
  importConfig
};
