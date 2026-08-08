const podService = require("../services/pod.service");
const { requireQueryFields, requireBodyFields } = require("../utils/validators");

async function listPods(req, res, next) {
  try {
    requireQueryFields(req.query, ["domain"]);
    const data = await podService.listPods(req.query.domain);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function listPodsForDbEnv(req, res, next) {
  try {
    requireQueryFields(req.query, ["dbEnv"]);
    const data = await podService.listPodsForDbEnv(req.query.dbEnv);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

// POST (không GET) vì body có thể chứa Rancher token gõ tay (ad-hoc, cluster chưa lưu) — token
// không nên nằm trong URL/log, cùng lý do các route "*-adhoc" khác ở settings.controller.js.
async function listPodsForDbEnvAdhoc(req, res, next) {
  try {
    requireBodyFields(req.body, ["namespace", "projectId"]);
    const data = await podService.listPodsForDbEnvAdhoc(req.body);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function describePod(req, res, next) {
  try {
    requireQueryFields(req.query, ["domain", "pod"]);
    const data = await podService.describePod(req.query.domain, req.query.pod);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function deletePod(req, res, next) {
  try {
    requireBodyFields(req.body, ["domain", "pod"]);
    const data = await podService.deletePod(req.body.domain, req.body.pod);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function restartPod(req, res, next) {
  try {
    requireBodyFields(req.body, ["domain", "pod"]);
    const data = await podService.restartPod(req.body.domain, req.body.pod);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function getPodStatus(req, res, next) {
  try {
    requireQueryFields(req.query, ["domain", "pod"]);
    const data = await podService.getPodStatus(req.query.domain, req.query.pod);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listPods,
  listPodsForDbEnv,
  listPodsForDbEnvAdhoc,
  describePod,
  deletePod,
  restartPod,
  getPodStatus
};
