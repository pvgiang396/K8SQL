"use strict";

const permissionsService = require("../services/permissions.service");
const { requireQueryFields } = require("../utils/validators");

async function checkAccess(req, res, next) {
  try {
    requireQueryFields(req.query, ["domain"]);
    const data = await permissionsService.checkAccess(req.query.domain);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

module.exports = { checkAccess };
