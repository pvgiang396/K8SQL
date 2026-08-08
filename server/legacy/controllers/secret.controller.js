const secretService = require("../services/secret.service");
const { requireQueryFields } = require("../utils/validators");

async function readSecret(req, res, next) {
  try {
    requireQueryFields(req.query, ["domain", "secret"]);
    const data = await secretService.readSecret(req.query.domain, req.query.secret);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function getSecretYaml(req, res, next) {
  try {
    requireQueryFields(req.query, ["domain", "secret"]);
    const data = await secretService.getSecretYaml(req.query.domain, req.query.secret);
    res.type("text/yaml").send(data);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  readSecret,
  getSecretYaml
};
