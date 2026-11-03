"use strict";

// 3 hàm dưới đây phục vụ cây Object Explorer tải lười theo từng cấp (cấp 2/3/4) — mỗi lần expand
// 1 node ở UI gọi đúng 1 hàm tương ứng. logOperation() KHÔNG gọi ở đây — tập trung ở dispatcher
// services/db.service.js (đúng coding rule chung, xem k8sctl/CLAUDE.md).
const { AppError } = require("../../../utils/error");
const { getPool } = require("./query");

// Cùng công thức phân trang đã dùng ở postgres/query.js::runQuery() (LIMIT/OFFSET + count(*) OVER()
// gắn tổng số dòng vào mỗi dòng trả về, tránh phải chạy thêm 1 query COUNT riêng) — 3 hàm dưới đây
// đều là SELECT phẳng trên information_schema.* có ORDER BY sẵn nên áp dụng được y nguyên, phân
// trang THẬT ở tầng DB (khác Mongo — xem mongo/schema.js, không có LIMIT/OFFSET native).
const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 100;

function resolvePaging(page, pageSize) {
  const safePage = Math.max(1, Math.trunc(Number(page)) || 1);
  const safePageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(pageSize)) || DEFAULT_PAGE_SIZE));
  return { safePage, safePageSize, offset: (safePage - 1) * safePageSize };
}

function buildPageResult(rows, mapRow, safePage, safePageSize) {
  const totalRows = rows.length > 0 ? Number(rows[0].__k8sctl_total_count) : 0;
  return {
    page: safePage,
    pageSize: safePageSize,
    totalRows,
    totalPages: Math.ceil(totalRows / safePageSize),
    rows: rows.map(mapRow)
  };
}

async function listSchemas(env, { page, pageSize } = {}) {
  const { safePage, safePageSize, offset } = resolvePaging(page, pageSize);
  const pool = await getPool(env);
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT schema_name, count(*) OVER() AS __k8sctl_total_count
       FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
       ORDER BY schema_name
       LIMIT $1 OFFSET $2`,
      [safePageSize, offset]
    );
    return buildPageResult(result.rows, (row) => row.schema_name, safePage, safePageSize);
  } catch (error) {
    throw error instanceof AppError ? error : new AppError(error.message, 400);
  } finally {
    client.release();
  }
}

async function listTables(env, schema, { page, pageSize } = {}) {
  const { safePage, safePageSize, offset } = resolvePaging(page, pageSize);
  const pool = await getPool(env);
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT table_name, count(*) OVER() AS __k8sctl_total_count
       FROM information_schema.tables WHERE table_schema = $1
       ORDER BY table_name
       LIMIT $2 OFFSET $3`,
      [schema, safePageSize, offset]
    );
    return buildPageResult(result.rows, (row) => row.table_name, safePage, safePageSize);
  } catch (error) {
    throw error instanceof AppError ? error : new AppError(error.message, 400);
  } finally {
    client.release();
  }
}

async function listColumns(env, schema, table, { page, pageSize } = {}) {
  const { safePage, safePageSize, offset } = resolvePaging(page, pageSize);
  const pool = await getPool(env);
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT column_name, data_type, is_nullable, column_default, count(*) OVER() AS __k8sctl_total_count
       FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position
       LIMIT $3 OFFSET $4`,
      [schema, table, safePageSize, offset]
    );
    // Chỉ throw 404 khi bảng THẬT SỰ không có cột nào (totalRows === 0) — không phải khi trang yêu
    // cầu vượt totalRows (frontend chỉ gọi trang sau khi trang trước đầy nên trường hợp này hiếm
    // xảy ra, nhưng vẫn phải phân biệt đúng với "bảng không tồn tại/không có cột").
    if (result.rows.length === 0 && safePage === 1) {
      throw new AppError(`Không tìm thấy bảng "${schema}.${table}".`, 404);
    }
    return buildPageResult(
      result.rows,
      ({ __k8sctl_total_count, ...row }) => row,
      safePage,
      safePageSize
    );
  } catch (error) {
    throw error instanceof AppError ? error : new AppError(error.message, 400);
  } finally {
    client.release();
  }
}

// Phục vụ cột Thao tác (Sửa/Xoá) của GUI trên bảng kết quả — cần PK để build UPDATE/DELETE an toàn
// (WHERE theo PK, không đoán cột nào "trông giống" khoá). Trả mảng rỗng (không throw) khi bảng không
// tồn tại/không có PK — FE coi đó là tín hiệu "không xác định được PK" để tự ẩn Sửa/Xoá.
async function getPrimaryKeyColumns(env, schema, table) {
  const pool = await getPool(env);
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT a.attname AS column_name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = ($1 || '.' || $2)::regclass AND i.indisprimary
       ORDER BY array_position(i.indkey, a.attnum)`,
      [schema, table]
    );
    return result.rows.map((row) => row.column_name);
  } catch {
    return [];
  } finally {
    client.release();
  }
}

module.exports = {
  listSchemas,
  listTables,
  listColumns,
  getPrimaryKeyColumns
};
