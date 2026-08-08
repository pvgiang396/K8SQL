'use strict';

const provisionService = require("../services/provision.service");
const { requireBodyFields, requireQueryFields } = require("../utils/validators");

async function applyYaml(req, res, next) {
  try {
    requireBodyFields(req.body, ["namespace", "yaml"]);
    if (!req.body.rancherCluster && !req.body.configPath) {
      const { AppError } = require("../utils/error");
      throw new AppError("Phải truyền rancherCluster hoặc configPath.", 400);
    }
    const data = await provisionService.applyYaml({
      rancherCluster: req.body.rancherCluster,
      configPath: req.body.configPath,
      namespace: req.body.namespace,
      yaml: req.body.yaml
    });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function addGroup(req, res, next) {
  try {
    requireBodyFields(req.body, ["name", "namespace", "domains"]);
    const data = await provisionService.addGroup({
      name: req.body.name,
      provider: req.body.provider,
      rancherCluster: req.body.rancherCluster,
      projectId: req.body.projectId,
      configPath: req.body.configPath,
      namespace: req.body.namespace,
      domains: req.body.domains,
      services: req.body.services
    });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function readiness(req, res, next) {
  try {
    requireQueryFields(req.query, ["domain"]);
    const data = await provisionService.readiness(req.query.domain);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

module.exports = { applyYaml, addGroup, readiness };
