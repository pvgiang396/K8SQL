"use strict";

const dbEnvironmentService = require("../services/db-environment.service");

async function listEnvironments(_req, res, next) {
  try {
    const data = dbEnvironmentService.listEnvironmentsPublic();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listEnvironments
};
