"use strict";

const dbConfigService = require("../services/db-config.service");

async function exportConfig(_req, res, next) {
  try {
    const data = dbConfigService.exportConfig();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function importConfig(req, res, next) {
  try {
    const data = dbConfigService.importConfig(req.body || {});
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  exportConfig,
  importConfig
};
