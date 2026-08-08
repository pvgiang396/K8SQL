"use strict";

const dbService = require("../services/db.service");
const { requireQueryFields } = require("../utils/validators");

// page/pageSize đọc từ query string (GET) — khác db-query.controller.js đọc từ req.body (POST) —
// Number(undefined) = NaN, dispatcher/provider tự fallback về mặc định (page=1/pageSize=100) khi
// gặp NaN/không truyền, xem resolvePaging()/paginateArray() ở từng provider schema.js.
function readPaging(query) {
  return {
    page: query.page !== undefined ? Number(query.page) : undefined,
    pageSize: query.pageSize !== undefined ? Number(query.pageSize) : undefined
  };
}

async function listSchemas(req, res, next) {
  try {
    requireQueryFields(req.query, ["env"]);
    const data = await dbService.listSchemas(req.query.env, readPaging(req.query));
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function listTables(req, res, next) {
  try {
    requireQueryFields(req.query, ["env", "schema"]);
    const data = await dbService.listTables(req.query.env, req.query.schema, readPaging(req.query));
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function listColumns(req, res, next) {
  try {
    requireQueryFields(req.query, ["env", "schema", "table"]);
    const data = await dbService.listColumns(req.query.env, req.query.schema, req.query.table, readPaging(req.query));
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function getAutocompleteSchema(req, res, next) {
  try {
    requireQueryFields(req.query, ["env"]);
    const data = await dbService.getFullSchema(req.query.env);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listSchemas,
  listTables,
  listColumns,
  getAutocompleteSchema
};
