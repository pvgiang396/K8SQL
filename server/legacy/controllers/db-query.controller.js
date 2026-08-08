"use strict";

const dbService = require("../services/db.service");
const { requireBodyFields } = require("../utils/validators");

async function query(req, res, next) {
  try {
    requireBodyFields(req.body, ["env", "sql"]);
    const { page, pageSize, database } = req.body;
    const data = await dbService.runQuery(req.body.env, req.body.sql, { page, pageSize, database });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  query
};
