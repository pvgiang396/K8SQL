const { AppError } = require("./error");

function assertRequired(value, name) {
  if (value === undefined || value === null || value === "") {
    throw new AppError(`Missing required field: ${name}`, 400);
  }
}

function requireQueryFields(query, fields) {
  for (const field of fields) {
    assertRequired(query[field], field);
  }
}

function requireBodyFields(body, fields) {
  for (const field of fields) {
    assertRequired(body[field], field);
  }
}

function parseNonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AppError(`${name} must be a non-negative integer.`, 400);
  }
  return parsed;
}

function requireNonEmptyArray(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AppError(`${name} must be a non-empty array.`, 400);
  }
  return value;
}

module.exports = {
  requireQueryFields,
  requireBodyFields,
  parseNonNegativeInteger,
  requireNonEmptyArray
};
