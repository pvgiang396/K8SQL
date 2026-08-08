const resolveService = require("../services/resolve.service");
const { requireQueryFields } = require("../utils/validators");

async function resolveGroup(req, res, next) {
  try {
    requireQueryFields(req.query, ["domain"]);
    const data = await resolveService.resolveGroup(req.query.domain);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  resolveGroup
};
