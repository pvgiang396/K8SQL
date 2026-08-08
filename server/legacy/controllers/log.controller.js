const logService = require("../services/log.service");
const { requireBodyFields } = require("../utils/validators");

async function searchLogs(req, res, next) {
  try {
    requireBodyFields(req.body, ["domain"]);
    const data = await logService.searchLogs(req.body);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  searchLogs
};
