const configMapService = require("../services/configmap.service");
const { requireQueryFields, requireBodyFields } = require("../utils/validators");

async function readConfigMap(req, res, next) {
  try {
    requireQueryFields(req.query, ["domain", "configMap"]);
    const data = await configMapService.readConfigMap(req.query.domain, req.query.configMap);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function getConfigMapYaml(req, res, next) {
  try {
    requireQueryFields(req.query, ["domain", "configMap"]);
    const data = await configMapService.getConfigMapYaml(req.query.domain, req.query.configMap);
    res.type("text/yaml").send(data);
  } catch (error) {
    next(error);
  }
}

async function updateConfigMapKey(req, res, next) {
  try {
    requireBodyFields(req.body, ["domain", "configMap", "key", "value"]);
    const data = await configMapService.updateConfigMapKey(
      req.body.domain,
      req.body.configMap,
      req.body.key,
      req.body.value
    );
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function deleteConfigMap(req, res, next) {
  try {
    requireBodyFields(req.body, ["domain", "configMap"]);
    const data = await configMapService.deleteConfigMap(req.body.domain, req.body.configMap);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  readConfigMap,
  getConfigMapYaml,
  updateConfigMapKey,
  deleteConfigMap
};
