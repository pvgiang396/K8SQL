const ingressService = require("../services/ingress.service");
const { requireQueryFields, requireBodyFields, parseNonNegativeInteger, requireNonEmptyArray } = require("../utils/validators");
const { AppError } = require("../utils/error");

async function listIngresses(req, res, next) {
  try {
    requireQueryFields(req.query, ["domain"]);
    const data = await ingressService.listIngresses(req.query.domain);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function describeIngress(req, res, next) {
  try {
    requireQueryFields(req.query, ["domain", "ingress"]);
    const data = await ingressService.describeIngress(req.query.domain, req.query.ingress);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function getIngressYaml(req, res, next) {
  try {
    requireQueryFields(req.query, ["domain", "ingress"]);
    const data = await ingressService.getIngressYaml(req.query.domain, req.query.ingress);
    res.type("text/yaml").send(data);
  } catch (error) {
    next(error);
  }
}

async function upsertIngress(req, res, next) {
  try {
    requireBodyFields(req.body, [
      "domain",
      "name",
      "host",
      "paths",
      "rewriteTarget",
      "backendServiceName",
      "backendServicePort",
      "proxyReadTimeoutSec",
      "proxySendTimeoutSec"
    ]);
    const paths = requireNonEmptyArray(req.body.paths, "paths");
    const spec = {
      name: req.body.name,
      host: req.body.host,
      paths,
      rewriteTarget: req.body.rewriteTarget,
      backendServiceName: req.body.backendServiceName,
      backendServicePort: parseNonNegativeInteger(req.body.backendServicePort, "backendServicePort"),
      proxyReadTimeoutSec: parseNonNegativeInteger(req.body.proxyReadTimeoutSec, "proxyReadTimeoutSec"),
      proxySendTimeoutSec: parseNonNegativeInteger(req.body.proxySendTimeoutSec, "proxySendTimeoutSec")
    };
    const data = await ingressService.upsertIngress(req.body.domain, spec);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function annotateIngress(req, res, next) {
  try {
    requireBodyFields(req.body, ["domain", "ingress", "annotations"]);
    if (typeof req.body.annotations !== "object" || req.body.annotations === null || Array.isArray(req.body.annotations)) {
      throw new AppError("annotations phải là object.", 400);
    }
    const data = await ingressService.annotateIngress(req.body.domain, req.body.ingress, req.body.annotations);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listIngresses,
  describeIngress,
  getIngressYaml,
  upsertIngress,
  annotateIngress
};
