const diagnoseService = require("../services/diagnose.service");
const { requireQueryFields } = require("../utils/validators");

async function diagnose(req, res, next) {
  try {
    requireQueryFields(req.query, ["domain", "service"]);
    const data = await diagnoseService.diagnose(req.query.domain, req.query.service);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  diagnose
};
