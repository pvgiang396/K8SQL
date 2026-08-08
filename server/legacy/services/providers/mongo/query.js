"use strict";

// Provider Mongo song song với services/providers/postgres/query.js — cùng shape response
// {rowCount, page, pageSize, totalRows, totalPages, fields, rows} để dispatcher
// (services/db.service.js) + controllers/db-query.controller.js không cần biết engine nào đang
// chạy. logOperation() KHÔNG gọi ở đây — tập trung ở dispatcher.
const { MongoClient } = require("mongodb");
// EJSON không được re-export qua "mongodb" ở bản driver này — lấy thẳng từ "bson" (dependency của
// mongodb, luôn có sẵn trong node_modules khi đã cài "mongodb").
const { EJSON } = require("bson");
const { AppError } = require("../../../utils/error");
const dbTunnelService = require("../../dbtunnel.service");
const dbEnvironmentService = require("../../db-environment.service");

// Driver cũ (mongodb@3.7.4, cài dưới alias "mongodb-legacy-driver" trong package.json qua cú pháp
// npm:mongodb@^3.7.4) — CHỈ dùng cho MongoDB server quá cũ (wire version < 8, tức < MongoDB 4.2)
// mà driver "mongodb" 6.x hiện tại từ chối kết nối (throw "requires at least..."). Không hạ driver
// chính xuống 3.x vì sẽ mất hiệu năng/tính năng cho mọi connection khác đang chạy server mới bình
// thường — 2 driver version cùng tồn tại song song, chọn theo từng environment.
const { MongoClient: LegacyMongoClient } = require("mongodb-legacy-driver");
// bson đi kèm driver 3.x là bản 1.1.x — KHÔNG có EJSON (chỉ xuất hiện từ bson 4.x) nên không dùng
// chung EJSON của "bson" 6.x cho document lấy từ driver cũ (ObjectID/Long... của bson 1.x không
// được bson 6.x's EJSON nhận diện, sẽ throw BSONVersionError) — legacySerialize() bên dưới tự nhận
// diện qua field "_bsontype" (string) nên không cần require thẳng class bson 1.x nào.

const MAX_ROWS = 500;
const MAX_PAGE_SIZE = 500;

// Lỗi driver 6.x ném ra khi server MongoDB quá cũ, vd: "Server at host:port reports maximum wire
// version 7, but this version of the Node.js Driver requires at least 8 (MongoDB 4.2)".
const WIRE_VERSION_ERROR_PATTERN = /wire version|requires at least/i;

// Serialize document lấy từ driver cũ (bson 1.x) sang cùng shape {$oid}/{$date} mà EJSON (bson
// 6.x) tạo ra cho driver mới — 2 field DUY NHẤT frontend nhận diện riêng (json-tree.js), các loại
// BSON hiếm khác (Long/Decimal128/Timestamp/Binary) fallback về toString() cho hiển thị được, không
// cần round-trip lại thành BSON (k8sctl chỉ hiển thị, không ghi ngược giá trị này).
function legacySerialize(value) {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value._bsontype === "ObjectID" || value._bsontype === "ObjectId") {
    return { $oid: value.toHexString() };
  }
  if (value._bsontype === "Long") {
    return typeof value.toNumber === "function" ? value.toNumber() : value.toString();
  }
  if (["Decimal128", "Timestamp", "Binary"].includes(value._bsontype)) {
    return value.toString();
  }
  if (Array.isArray(value)) return value.map(legacySerialize);
  const out = {};
  for (const [key, val] of Object.entries(value)) out[key] = legacySerialize(val);
  return out;
}

// Chỉ các method sau được coi là ĐỌC — luôn cho phép bất kể allowWrite. Method KHÔNG có trong 2 danh
// sách này (vd bulkWrite, findOneAndX...) bị từ chối thẳng — mở rộng thêm khi thật sự cần, không
// đoán/whitelist rộng hơn nhu cầu hiện tại.
const READ_METHODS = new Set(["find", "findOne", "aggregate", "countDocuments", "distinct"]);
const WRITE_METHODS = new Set([
  "insertOne", "insertMany", "updateOne", "updateMany",
  "deleteOne", "deleteMany", "replaceOne", "drop"
]);

// env.name -> { client, localPort } — cùng pattern cache với providers/postgres/query.js's `pools`.
const clients = new Map();

async function resolveConnectionInfo(env) {
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

async function connectWithDriver(driver, connectionString) {
  const client =
    driver === "legacy"
      ? new LegacyMongoClient(connectionString, {
          useNewUrlParser: true,
          useUnifiedTopology: true,
          serverSelectionTimeoutMS: 8000
        })
      : new MongoClient(connectionString, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  return client;
}

async function getClientEntry(env) {
  const { connectionString, localPort } = await resolveConnectionInfo(env);
  const cached = clients.get(env.name);
  if (cached && cached.localPort === localPort) {
    return cached;
  }
  if (cached) {
    cached.client.close().catch(() => {});
  }

  let driver = env.mongoDriver === "legacy" ? "legacy" : "modern";
  let client;
  try {
    client = await connectWithDriver(driver, connectionString);
  } catch (error) {
    // Server MongoDB quá cũ (wire version thấp hơn driver 6.x yêu cầu) — tự fallback sang driver
    // 3.x rồi ghi nhớ vào config/db-environments.json để lần kết nối sau không cần thử driver mới
    // trước (tránh chờ serverSelectionTimeoutMS ~8s mỗi lần). Lỗi khác (sai host/port/auth...) thì
    // ném thẳng, không đoán mò fallback.
    if (driver === "modern" && WIRE_VERSION_ERROR_PATTERN.test(error.message || "")) {
      driver = "legacy";
      client = await connectWithDriver(driver, connectionString);
      try {
        dbEnvironmentService.setMongoDriverPreference(env.name, "legacy");
      } catch {
        // Không chặn kết nối chỉ vì ghi file thất bại (vd file readonly) — vẫn dùng driver cũ cho
        // phiên hiện tại, chỉ mất tác dụng "nhớ" cho lần khởi động sau.
      }
    } else {
      throw error;
    }
  }

  const entry = { client, localPort, driver };
  clients.set(env.name, entry);
  return entry;
}

async function getClient(env) {
  const { client } = await getClientEntry(env);
  return client;
}

// Tên database mặc định lấy từ path của connection string (vd "mongodb://host/mydb" -> "mydb") —
// dùng khi user không chọn rõ database nào qua cây Object Explorer (level 2, xem schema.js).
function defaultDbName(env) {
  const template = String(process.env[env.connectionStringEnvVar] || "");
  try {
    const url = new URL(template.replace("__HOST__", "placeholder-host"));
    return url.pathname.replace(/^\//, "") || undefined;
  } catch {
    return undefined;
  }
}

async function getDb(env, databaseName) {
  const { client } = await getClientEntry(env);
  const dbName = databaseName || defaultDbName(env);
  if (!dbName) {
    throw new AppError(
      `Chưa xác định được database Mongo nào để dùng — chọn 1 database trong cây Object Explorer hoặc thêm tên database vào connection string.`,
      400
    );
  }
  return client.db(dbName);
}

// Parse "db.<collection>.<method>(<argsJson>)" — KHÔNG dùng eval()/new Function() (args đến từ input
// người dùng, rủi ro thực thi mã tuỳ ý) — chỉ regex tách method + EJSON.parse phần tham số (hỗ trợ cú
// pháp Extended JSON như {"$oid": "..."}/{"$date": "..."} cho ObjectId/Date mà không cần eval).
const CALL_PATTERN = /^db\.(\w+)\.(\w+)\((.*)\)$/s;

// Cho phép gõ cú pháp constructor kiểu mongosh (`ObjectId("...")`/`new ObjectId("...")`/
// `ISODate("...")`) — UI hiển thị kết quả đúng dạng này (json-tree.js) nên user tự nhiên copy lại
// khi viết query mới, nhưng Extended JSON chuẩn chỉ chấp nhận `{"$oid": "..."}`/`{"$date": "..."}`.
// Dịch bằng regex CHẶT (hex 24 ký tự cho ObjectId) trước khi đưa vào EJSON.parse — KHÔNG eval, chỉ
// thay thế đúng 1 pattern literal cố định nên không có rủi ro thực thi mã tuỳ ý. Giới hạn đã biết:
// nếu 1 string value trong query TÌNH CỜ chứa nguyên văn "ObjectId(\"...\")" (hiếm khi xảy ra) sẽ bị
// dịch nhầm — chấp nhận đánh đổi vì lợi ích tiện dụng lớn hơn rủi ro cạnh biên này.
function translateShellConstructors(str) {
  return str
    .replace(/(?:new\s+)?ObjectId\(\s*"([0-9a-fA-F]{24})"\s*\)/g, '{"$oid":"$1"}')
    .replace(/(?:new\s+)?ISODate\(\s*"([^"\\]*)"\s*\)/g, '{"$date":"$1"}');
}

function parseMongoCall(raw) {
  const trimmed = String(raw || "").trim().replace(/;\s*$/, "");
  if (!trimmed) {
    throw new AppError("Câu lệnh Mongo rỗng.", 400);
  }
  const match = CALL_PATTERN.exec(trimmed);
  if (!match) {
    throw new AppError(
      'Chỉ hỗ trợ cú pháp "db.<collection>.<method>(<tham số JSON>)", vd db.users.find({"age": {"$gt": 18}}).',
      400
    );
  }
  const [, collection, method, argsRaw] = match;
  if (!READ_METHODS.has(method) && !WRITE_METHODS.has(method)) {
    throw new AppError(
      `Method "${method}" chưa được hỗ trợ — chỉ hỗ trợ đọc (${[...READ_METHODS].join(", ")}) hoặc ghi (${[...WRITE_METHODS].join(", ")}).`,
      400
    );
  }

  let args = [];
  const argsTrimmed = argsRaw.trim();
  if (argsTrimmed) {
    try {
      args = EJSON.parse(`[${translateShellConstructors(argsTrimmed)}]`, { relaxed: true });
    } catch (error) {
      throw new AppError(`Tham số không phải JSON hợp lệ: ${error.message}`, 400);
    }
    if (!Array.isArray(args)) {
      args = [args];
    }
  }

  return { collection, method, args, isWrite: WRITE_METHODS.has(method) };
}

async function runQuery(env, envName, sql, { page, pageSize, database } = {}) {
  const { collection: collectionName, method, args, isWrite } = parseMongoCall(sql);

  if (isWrite && !env.allowWrite) {
    throw new AppError(
      `Environment "${envName}" chưa bật allowWrite trong config/db-environments.json — chỉ hỗ trợ đọc (${[...READ_METHODS].join(", ")}).`,
      403
    );
  }

  const { client, driver } = await getClientEntry(env);
  const dbName = database || defaultDbName(env);
  if (!dbName) {
    throw new AppError(
      `Chưa xác định được database Mongo nào để dùng — chọn 1 database trong cây Object Explorer hoặc thêm tên database vào connection string.`,
      400
    );
  }
  const db = client.db(dbName);
  const collection = db.collection(collectionName);
  const serialize = driver === "legacy" ? legacySerialize : (doc) => EJSON.serialize(doc);

  if (isWrite) {
    return runWrite(collection, method, args, serialize);
  }
  return runRead(collection, method, args, { page, pageSize }, serialize);
}

async function runWrite(collection, method, args, serialize) {
  const result = await collection[method](...args);
  const serialized = serialize(result || {});
  return {
    kind: "write",
    rowCount: Number(
      result?.insertedCount ?? result?.modifiedCount ?? result?.deletedCount ?? result?.upsertedCount ?? 0
    ),
    fields: [],
    rows: [serialized]
  };
}

async function runRead(collection, method, args, { page, pageSize }, serialize) {
  if (method === "countDocuments") {
    const count = await collection.countDocuments(...args);
    return { kind: "query", rowCount: 1, fields: ["count"], rows: [{ count }] };
  }
  if (method === "distinct") {
    const values = await collection.distinct(...args);
    return { kind: "query", rowCount: values.length, fields: ["value"], rows: values.map((value) => ({ value })) };
  }
  if (method === "findOne") {
    const doc = await collection.findOne(...args);
    const rows = doc ? [serialize(doc)] : [];
    return { kind: "query", rowCount: rows.length, fields: [], rows };
  }

  const paginated = page !== undefined;
  let safePage, safePageSize;
  if (paginated) {
    safePage = Math.max(1, Math.trunc(Number(page)) || 1);
    safePageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(pageSize)) || 10));
  }

  if (method === "aggregate") {
    const pipeline = Array.isArray(args[0]) ? args[0] : [];
    if (!paginated) {
      const docs = await collection.aggregate([...pipeline, { $limit: MAX_ROWS + 1 }]).toArray();
      const truncated = docs.length > MAX_ROWS;
      const rows = (truncated ? docs.slice(0, MAX_ROWS) : docs).map((doc) => serialize(doc));
      return { kind: "query", rowCount: rows.length, truncated, fields: [], rows };
    }
    const offset = (safePage - 1) * safePageSize;
    const [facetResult] = await collection
      .aggregate([...pipeline, { $facet: { data: [{ $skip: offset }, { $limit: safePageSize }], count: [{ $count: "total" }] } }])
      .toArray();
    const totalRows = facetResult?.count?.[0]?.total || 0;
    const rows = (facetResult?.data || []).map((doc) => serialize(doc));
    return {
      kind: "query",
      rowCount: rows.length,
      page: safePage,
      pageSize: safePageSize,
      totalRows,
      totalPages: Math.ceil(totalRows / safePageSize),
      fields: [],
      rows
    };
  }

  // method === "find"
  const [filter = {}, options = {}] = args;
  if (!paginated) {
    const docs = await collection.find(filter, options).limit(MAX_ROWS + 1).toArray();
    const truncated = docs.length > MAX_ROWS;
    const rows = (truncated ? docs.slice(0, MAX_ROWS) : docs).map((doc) => serialize(doc));
    return { kind: "query", rowCount: rows.length, truncated, fields: [], rows };
  }

  const offset = (safePage - 1) * safePageSize;
  const [docs, totalRows] = await Promise.all([
    collection.find(filter, options).skip(offset).limit(safePageSize).toArray(),
    collection.countDocuments(filter)
  ]);
  const rows = docs.map((doc) => serialize(doc));
  return {
    kind: "query",
    rowCount: rows.length,
    page: safePage,
    pageSize: safePageSize,
    totalRows,
    totalPages: Math.ceil(totalRows / safePageSize),
    fields: [],
    rows
  };
}

// Test kết nối vô hại (không side-effect) — dùng cho icon "Kiểm tra kết nối" ở Settings UI, xem
// services/db.service.js::testConnection(). "admin" luôn tồn tại bất kể database mặc định của
// connection string là gì — không cần defaultDbName().
async function ping(env) {
  const client = await getClient(env);
  await client.db("admin").command({ ping: 1 });
}

// pingAdhoc — như ping() nhưng nhận thẳng 1 connection string ĐÃ RESOLVE sẵn (không đọc process.env,
// không cache vào `clients` theo env.name) — dùng cho entry Connection String CHƯA "Áp dụng" (isNew)
// ở Settings UI, xem services/db.service.js::testConnectionAdhoc(). Client 1-lần-dùng, luôn đóng
// ngay sau khi xong; giữ cùng logic fallback driver "legacy" (server Mongo quá cũ) như getClientEntry()
// nhưng KHÔNG ghi setMongoDriverPreference() (chưa có entry lưu trên đĩa để ghi vào).
async function pingAdhoc(connectionString) {
  let client;
  try {
    client = await connectWithDriver("modern", connectionString);
  } catch (error) {
    if (!WIRE_VERSION_ERROR_PATTERN.test(error.message || "")) throw error;
    client = await connectWithDriver("legacy", connectionString);
  }
  try {
    await client.db("admin").command({ ping: 1 });
  } finally {
    client.close().catch(() => {});
  }
}

module.exports = {
  runQuery,
  getClient,
  getDb,
  defaultDbName,
  ping,
  pingAdhoc
};
