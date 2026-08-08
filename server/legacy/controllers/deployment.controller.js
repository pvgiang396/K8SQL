const deploymentService = require("../services/deployment.service");
const { requireQueryFields, requireBodyFields, parseNonNegativeInteger } = require("../utils/validators");

async function listDeployments(req, res, next) {
  try {
    requireQueryFields(req.query, ["domain"]);
    const data = await deploymentService.listDeployments(req.query.domain);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function describeDeployment(req, res, next) {
  try {
    requireQueryFields(req.query, ["domain", "deployment"]);
    const data = await deploymentService.describeDeployment(req.query.domain, req.query.deployment);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function getDeploymentYaml(req, res, next) {
  try {
    requireQueryFields(req.query, ["domain", "deployment"]);
    const data = await deploymentService.getDeploymentYaml(req.query.domain, req.query.deployment);
    res.type("text/yaml").send(data);
  } catch (error) {
    next(error);
  }
}

async function restartDeployment(req, res, next) {
  try {
    requireBodyFields(req.body, ["domain", "deployment"]);
    const data = await deploymentService.restartDeployment(req.body.domain, req.body.deployment);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function scaleDeployment(req, res, next) {
  try {
    requireBodyFields(req.body, ["domain", "deployment", "replicas"]);
    const replicas = parseNonNegativeInteger(req.body.replicas, "replicas");
    const data = await deploymentService.scaleDeployment(req.body.domain, req.body.deployment, replicas);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function setDeploymentImage(req, res, next) {
  try {
    requireBodyFields(req.body, ["domain", "deployment", "image"]);
    const data = await deploymentService.setDeploymentImage(
      req.body.domain,
      req.body.deployment,
      req.body.image,
      req.body.container
    );
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function deleteDeployment(req, res, next) {
  try {
    requireBodyFields(req.body, ["domain", "deployment"]);
    const data = await deploymentService.deleteDeployment(req.body.domain, req.body.deployment);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listDeployments,
  describeDeployment,
  getDeploymentYaml,
  restartDeployment,
  scaleDeployment,
  setDeploymentImage,
  deleteDeployment
};
