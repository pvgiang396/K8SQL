const serviceService = require("../services/service.service");
const { requireQueryFields, requireBodyFields } = require("../utils/validators");

async function listServices(req, res, next) {
  try {
    requireQueryFields(req.query, ["domain"]);
    const data = await serviceService.listServices(req.query.domain);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function describeService(req, res, next) {
  try {
    requireQueryFields(req.query, ["domain", "service"]);
    const data = await serviceService.describeService(req.query.domain, req.query.service);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function getServiceYaml(req, res, next) {
  try {
    requireQueryFields(req.query, ["domain", "service"]);
    const data = await serviceService.getServiceYaml(req.query.domain, req.query.service);
    res.type("text/yaml").send(data);
  } catch (error) {
    next(error);
  }
}

async function deleteService(req, res, next) {
  try {
    requireBodyFields(req.body, ["domain", "service"]);
    const data = await serviceService.deleteService(req.body.domain, req.body.service);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listServices,
  describeService,
  getServiceYaml,
  deleteService
};
