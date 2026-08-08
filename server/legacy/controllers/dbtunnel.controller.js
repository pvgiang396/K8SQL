"use strict";

const dbTunnelService = require("../services/dbtunnel.service");
const dbEnvironmentService = require("../services/db-environment.service");
const { requireBodyFields } = require("../utils/validators");

async function openTunnel(req, res, next) {
  try {
    requireBodyFields(req.body, ["domain"]);
    const data = await dbTunnelService.openTunnel(req.body.domain);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function closeTunnel(req, res, next) {
  try {
    requireBodyFields(req.body, ["domain"]);
    const data = await dbTunnelService.closeTunnel(req.body.domain);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

// openTunnelForEnv/closeTunnelForEnv — mở local port TCP thô (raw) qua CHÍNH tunnel dbEnv
// "tự đủ" (rancherKey, kể cả nhánh existingPodName exec-relay) mà /sql/query đã dùng nội bộ —
// không có sẵn HTTP endpoint nào lộ localPort này ra ngoài trước đây. Dùng khi cần chạy công cụ
// ngoài (vd pg_dump/psql) trỏ thẳng 127.0.0.1:<localPort> qua ĐÚNG đường mạng đã whitelist,
// thay vì phải mở 1 jump pod mới (có thể không được whitelist network, xem docs/team-notes.md).
async function openTunnelForEnv(req, res, next) {
  try {
    requireBodyFields(req.body, ["name"]);
    const env = dbEnvironmentService.getEnvironmentOrThrow(req.body.name);
    const data = await dbTunnelService.openTunnelForDbEnv(env);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function closeTunnelForEnv(req, res, next) {
  try {
    requireBodyFields(req.body, ["name"]);
    const data = await dbTunnelService.closeTunnelForDbEnv(req.body.name);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

module.exports = { openTunnel, closeTunnel, openTunnelForEnv, closeTunnelForEnv };
