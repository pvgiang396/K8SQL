"use strict";

// Cây Object Explorer cho Mongo: listSchemas() = danh sách DATABASE (cấp 2, dùng icon Postgres theo
// đúng yêu cầu mota.md), listTables() = danh sách COLLECTION (cấp 3, icon table.png — dùng CHUNG với
// bảng Postgres, đổi từ json.png ban đầu theo yêu cầu user 2026-08-05 vì icon tròn cam không phù
// hợp). Không có cấp 4 (Mongo schemaless) — listColumns() luôn trả rỗng để dispatcher/frontend không
// hiển thị caret mở rộng. logOperation() KHÔNG gọi ở đây — tập trung ở dispatcher services/db.service.js.
const { AppError } = require("../../../utils/error");
const { getClient, getDb } = require("./query");

// KHÁC Postgres (postgres/schema.js) — Mongo KHÔNG có phân trang thật ở tầng server cho 2 API này:
// listDatabases() là 1 command trả nguyên document (không phải cursor, không có tham số skip/limit
// nào cả — đã verify trực tiếp trong driver `mongodb` cài trong node_modules); listCollections() trả
// về 1 cursor thật nhưng KHÔNG kế thừa .skip()/.limit() (chỉ ListCollectionsCursor, không phải
// FindCursor), chỉ có batchSize (batch mạng, không phải phân trang logic). Vẫn gọi y nguyên API cũ
// (lấy full mảng — không có cách nào tránh được ở phía Mongo), rồi TỰ CẮT TRANG trong Node — đạt
// đúng mục tiêu UX (client không phải render hết 1 lần) nhưng KHÔNG giảm được chi phí truy vấn thật
// ở DB như Postgres, cần biết rõ giới hạn này.
const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 100;

function paginateArray(fullArray, page, pageSize) {
  const safePage = Math.max(1, Math.trunc(Number(page)) || 1);
  const safePageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(pageSize)) || DEFAULT_PAGE_SIZE));
  const offset = (safePage - 1) * safePageSize;
  const totalRows = fullArray.length;
  return {
    page: safePage,
    pageSize: safePageSize,
    totalRows,
    totalPages: Math.ceil(totalRows / safePageSize),
    rows: fullArray.slice(offset, offset + safePageSize)
  };
}

async function listSchemas(env, { page, pageSize } = {}) {
  const client = await getClient(env);
  try {
    const { databases } = await client.db().admin().listDatabases();
    const names = databases
      .map((item) => item.name)
      .filter((name) => !["admin", "local", "config"].includes(name))
      .sort();
    return paginateArray(names, page, pageSize);
  } catch (error) {
    throw error instanceof AppError ? error : new AppError(error.message, 400);
  }
}

async function listTables(env, databaseName, { page, pageSize } = {}) {
  try {
    const db = await getDb(env, databaseName);
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    const names = collections.map((item) => item.name).sort();
    return paginateArray(names, page, pageSize);
  } catch (error) {
    throw error instanceof AppError ? error : new AppError(error.message, 400);
  }
}

// Mongo không có khái niệm "cột" — cấp 4 không tồn tại, trả rỗng để phía dispatcher/frontend không
// hiển thị caret mở rộng cho node collection (xem mota.md: "không cần hiển thị danh sách trường").
// Không có DB call nào để phân trang thật — chỉ bọc đúng shape response chung.
async function listColumns() {
  return { page: 1, pageSize: DEFAULT_PAGE_SIZE, totalRows: 0, totalPages: 0, rows: [] };
}

module.exports = {
  listSchemas,
  listTables,
  listColumns
};
