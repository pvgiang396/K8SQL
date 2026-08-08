"use strict";

// Di dời gần như nguyên trạng từ services/db.service.js (trước khi tách dispatcher đa engine) — xem
// k8sctl/CLAUDE.md mục "Kiến trúc/Providers". logOperation() KHÔNG gọi ở đây — tập trung ở dispatcher
// services/db.service.js theo đúng coding rule đã có (không lặp lại logging trong provider).
const { Pool } = require("pg");
const { AppError } = require("../../../utils/error");
const dbTunnelService = require("../../dbtunnel.service");

const MAX_ROWS = 500;
const MAX_PAGE_SIZE = 500;

// Chặn cứng mọi câu ghi — không phải gợi ý, vì tính năng SQL này chỉ nên tồn tại như 1 tool ĐỌC.
// Danh sách cố tình rộng hơn nhu cầu (vd chặn cả SET/DO/LISTEN) để không phải đoán hết
// mọi cách 1 câu SQL có thể gây side-effect.
const FORBIDDEN_KEYWORDS = [
  "insert", "update", "delete", "drop", "alter", "truncate", "grant", "revoke",
  "create", "execute", "call", "copy", "merge", "vacuum", "reindex", "refresh",
  "lock", "listen", "notify", "unlisten", "set", "reset", "do", "comment", "into",
  "security"
];

// env.name -> { pool, localPort } — localPort null cho mode "direct" (connection string cố định,
// pool reuse mãi mãi như trước). Mode "k8s-tunnel" cần theo dõi localPort vì tunnel cũ có thể bị
// idle-cleanup (services/dbtunnel.service.js) và mở lại ở cổng khác — pool cũ sẽ không connect được nữa.
const pools = new Map();

// Mode "k8s-tunnel": connectionStringEnvVar chứa 1 TEMPLATE có placeholder "__HOST__" (vd
// "postgres://user:pass@__HOST__/dbname") — thay bằng 127.0.0.1:<localPort> sau khi mở tunnel.
async function resolveConnectionString(env) {
  const template = process.env[env.connectionStringEnvVar];
  if (!template) {
    throw new AppError(
      `Biến môi trường "${env.connectionStringEnvVar}" chưa được cấu hình trong k8sctl/.env cho environment "${env.name}".`,
      500
    );
  }

  if (env.mode !== "k8s-tunnel") {
    return { connectionString: template, localPort: null };
  }

  let localPort;
  if (env.rancherKey) {
    ({ localPort } = await dbTunnelService.openTunnelForDbEnv(env));
  } else if (env.domain) {
    ({ localPort } = await dbTunnelService.openTunnel(env.domain));
  } else {
    throw new AppError(
      `Environment "${env.name}" có mode "k8s-tunnel" nhưng thiếu field "rancherKey" (tự đủ) hoặc "domain" (qua namespaces.json) trong config/db-environments.json.`,
      500
    );
  }

  return { connectionString: template.replace("__HOST__", `127.0.0.1:${localPort}`), localPort };
}

async function getPool(env) {
  const { connectionString, localPort } = await resolveConnectionString(env);

  const cached = pools.get(env.name);
  if (cached && cached.localPort === localPort) {
    return cached.pool;
  }
  if (cached) {
    cached.pool.end().catch(() => {});
  }

  // connectionTimeoutMillis: mặc định pg KHÔNG có timeout (chờ vô hạn) — khi tunnel/relay k8s-tunnel
  // gặp sự cố (network chặn, relay treo...), UI "Kiểm tra kết nối" sẽ treo mãi thay vì báo lỗi rõ
  // ràng. Case thật đã gặp khi debug exec-relay qua pod có sẵn (2026-08-06).
  const pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 15000 });
  pools.set(env.name, { pool, localPort });
  return pool;
}

function stripSqlComments(sql) {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

// Dùng chung cho cả nhánh đọc (assertReadOnlySql) lẫn nhánh ghi (runWriteStatement) — chỉ đảm bảo
// đúng 1 câu lệnh, không rỗng, đã bỏ comment. Không quyết định câu đó được phép đọc hay ghi.
function normalizeSingleStatement(sql) {
  const trimmed = String(sql || "").trim();
  if (!trimmed) {
    throw new AppError("SQL rỗng.", 400);
  }

  const withoutComments = stripSqlComments(trimmed).trim();
  const withoutTrailingSemicolon = withoutComments.replace(/;\s*$/, "");

  if (withoutTrailingSemicolon.includes(";")) {
    throw new AppError("Chỉ cho phép 1 câu lệnh — không dùng ';' để nối nhiều câu SQL.", 400);
  }

  return withoutTrailingSemicolon;
}

// Lớp chặn #1 (nhanh, thông báo lỗi rõ ràng). Lớp chặn #2 (thật sự đảm bảo an toàn dù
// regex ở đây bị bỏ sót 1 trường hợp nào đó) nằm ở runQuery(): chạy trong transaction
// "READ ONLY" — Postgres tự chặn ở tầng engine, không phụ thuộc parse SQL bằng regex.
// Áp dụng cho MỌI câu bắt đầu bằng SELECT/WITH bất kể environment có allowWrite hay không —
// nhánh đọc không bao giờ nới lỏng, chỉ nhánh ghi (runWriteStatement) mới xét allowWrite.
function assertReadOnlySql(withoutTrailingSemicolon) {
  if (!/^(select|with)\b/i.test(withoutTrailingSemicolon)) {
    throw new AppError('Chỉ cho phép câu lệnh bắt đầu bằng "SELECT" hoặc "WITH" (CTE).', 400);
  }

  for (const keyword of FORBIDDEN_KEYWORDS) {
    const pattern = new RegExp(`\\b${keyword}\\b`, "i");
    if (pattern.test(withoutTrailingSemicolon)) {
      throw new AppError(
        `Câu lệnh chứa từ khóa không được phép: "${keyword.toUpperCase()}". Chỉ hỗ trợ đọc dữ liệu (SELECT/WITH thuần).`,
        400
      );
    }
  }

  return withoutTrailingSemicolon;
}

// Không truyền {page} (client cũ/AI gọi thẳng /sql/query không biết về phân trang) → giữ nguyên
// 100% hành vi cũ: bọc LIMIT 501, cap cứng MAX_ROWS=500, trả "truncated" — ranh giới an toàn/token
// cho AI không đổi. Có truyền {page,pageSize} (GUI dùng) → BỎ cap tổng, dùng LIMIT/OFFSET +
// count(*) OVER() để phân trang thật.
// Trả về kèm field "kind" ("query"/"write") để dispatcher (services/db.service.js) log đúng
// operation — KHÔNG phải 1 phần response thật trả cho client, dispatcher tự xoá trước khi trả ra.
async function runQuery(env, envName, sql, { page, pageSize } = {}) {
  const normalized = normalizeSingleStatement(sql);

  if (!/^(select|with)\b/i.test(normalized)) {
    return runWriteStatement(env, envName, normalized);
  }

  const safeSql = assertReadOnlySql(normalized);
  const pool = await getPool(env);
  const client = await pool.connect();

  const paginated = page !== undefined;
  let safePage, safePageSize;
  if (paginated) {
    safePage = Math.max(1, Math.trunc(Number(page)) || 1);
    safePageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(pageSize)) || 10));
  }

  try {
    await client.query("BEGIN TRANSACTION READ ONLY");

    if (!paginated) {
      // Bọc thêm 1 lớp SELECT ... LIMIT để Postgres tự cắt bớt kết quả phía server —
      // tránh trả về hàng chục nghìn dòng làm tốn quota AI đọc response không cần thiết.
      const wrappedSql = `SELECT * FROM (${safeSql}) AS k8sctl_sql_result LIMIT ${MAX_ROWS + 1}`;
      const result = await client.query(wrappedSql);
      await client.query("ROLLBACK");

      const truncated = result.rows.length > MAX_ROWS;
      const rows = truncated ? result.rows.slice(0, MAX_ROWS) : result.rows;

      return {
        kind: "query",
        rowCount: rows.length,
        truncated,
        fields: (result.fields || []).map((field) => field.name),
        rows
      };
    }

    // count(*) OVER() gắn tổng số dòng vào MỖI dòng trả về — chỉ cần đọc từ dòng đầu tiên (0 nếu
    // không có dòng nào), tránh phải chạy thêm 1 query COUNT(*) riêng.
    const wrappedSql = `SELECT *, count(*) OVER() AS __k8sctl_total_count
       FROM (${safeSql}) AS k8sctl_sql_result LIMIT $1 OFFSET $2`;
    const offset = (safePage - 1) * safePageSize;
    const result = await client.query(wrappedSql, [safePageSize, offset]);
    await client.query("ROLLBACK");

    const totalRows = result.rows.length > 0 ? Number(result.rows[0].__k8sctl_total_count) : 0;
    // __k8sctl_total_count là cột nội bộ phục vụ phân trang — không phải 1 phần kết quả thật của
    // câu SQL user gõ, phải loại khỏi cả "fields" lẫn từng object "rows" trước khi trả về client.
    const rows = result.rows.map(({ __k8sctl_total_count, ...row }) => row);
    const fields = (result.fields || [])
      .map((field) => field.name)
      .filter((name) => name !== "__k8sctl_total_count");

    return {
      kind: "query",
      rowCount: rows.length,
      page: safePage,
      pageSize: safePageSize,
      totalRows,
      totalPages: Math.ceil(totalRows / safePageSize),
      fields,
      rows
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore — connection có thể đã hỏng, sẽ bị loại khi release()
    }
    throw error instanceof AppError ? error : new AppError(error.message, 400);
  } finally {
    client.release();
  }
}

// Nhánh ghi — chỉ chạy khi env.allowWrite === true (cấu hình trong db-environments.json, không
// phải cờ client tự truyền lên, tránh 1 request lừa 1 env read-only chuyển sang ghi). Khác nhánh
// đọc: dùng transaction thường (BEGIN/COMMIT) để dữ liệu thật sự được lưu, không ROLLBACK.
async function runWriteStatement(env, envName, sql) {
  if (!env.allowWrite) {
    throw new AppError(
      `Environment "${envName}" chưa bật allowWrite trong config/db-environments.json — chỉ hỗ trợ câu lệnh SELECT/WITH.`,
      403
    );
  }

  const pool = await getPool(env);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(sql);
    await client.query("COMMIT");

    return {
      kind: "write",
      rowCount: result.rowCount,
      fields: (result.fields || []).map((field) => field.name),
      rows: result.rows || []
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore — connection có thể đã hỏng, sẽ bị loại khi release()
    }
    throw error instanceof AppError ? error : new AppError(error.message, 400);
  } finally {
    client.release();
  }
}

// Test kết nối vô hại (không side-effect) — dùng cho icon "Kiểm tra kết nối" ở Settings UI, xem
// services/db.service.js::testConnection().
async function ping(env) {
  const pool = await getPool(env);
  await pool.query("SELECT 1");
}

// pingAdhoc — kiểm tra kết nối bằng 1 connection string ĐÃ RESOLVE sẵn (không đọc process.env qua
// connectionStringEnvVar, không cache vào `pools` theo env.name) — dùng cho icon "Kiểm tra kết nối"
// khi entry Connection String CHƯA "Áp dụng" (isNew) ở Settings UI, xem
// services/db.service.js::testConnectionAdhoc(). Pool 1-lần-dùng, luôn đóng ngay sau khi xong.
async function pingAdhoc(connectionString) {
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 15000 });
  try {
    await pool.query("SELECT 1");
  } finally {
    pool.end().catch(() => {});
  }
}

module.exports = {
  runQuery,
  getPool,
  ping,
  pingAdhoc
};
