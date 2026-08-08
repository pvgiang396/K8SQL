const verifyService = require("../services/verify.service");
const { requireBodyFields } = require("../utils/validators");

async function verifyDeploy(req, res, next) {
  try {
    requireBodyFields(req.body, ["domain", "remotePath", "localFilePath"]);
    const data = await verifyService.verifyDeploy(req.body);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  verifyDeploy
};
