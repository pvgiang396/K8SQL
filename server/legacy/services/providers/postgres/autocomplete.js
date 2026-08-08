"use strict";

// Introspect toàn bộ schema (mọi bảng + cột) — nguồn dữ liệu cho autocomplete của UI SQL editor.
// CỐ Ý KHÔNG lười như listSchemas/listTables/listColumns: cây Object Explorer tải lười theo yêu
// cầu, nhưng autocomplete cần biết đủ bảng/cột ngay khi chọn 1 environment. logOperation() KHÔNG
// gọi ở đây — tập trung ở dispatcher services/db.service.js.
const { AppError } = require("../../../utils/error");
const { getPool } = require("./query");

async function getFullSchema(env) {
  const pool = await getPool(env);
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT table_schema, table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, table_name, ordinal_position`
    );

    const tablesByKey = new Map();
    for (const row of result.rows) {
      const key = `${row.table_schema}.${row.table_name}`;
      if (!tablesByKey.has(key)) {
        tablesByKey.set(key, { schema: row.table_schema, name: row.table_name, columns: [] });
      }
      tablesByKey.get(key).columns.push({ name: row.column_name, type: row.data_type });
    }

    return { tables: Array.from(tablesByKey.values()) };
  } catch (error) {
    throw error instanceof AppError ? error : new AppError(error.message, 400);
  } finally {
    client.release();
  }
}

module.exports = {
  getFullSchema
};
