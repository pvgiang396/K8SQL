const discoveryService = require("../services/discovery.service");
const { requireQueryFields } = require("../utils/validators");

async function reconcile(req, res, next) {
  try {
    requireQueryFields(req.query, ["rancherCluster"]);
    const data = await discoveryService.reconcileCluster(req.query.rancherCluster);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  reconcile
};
