"use strict";

// Dispatcher đa engine (postgres/mongo) — mirror pattern kubeconfig/rancher đã dùng cho
// services/kube.service.js (xem k8sctl/CLAUDE.md mục "Kiến trúc/Providers"): mỗi engine có 1 cặp
// implementation song song dưới services/providers/<engine>/*, dispatcher này chỉ chọn đúng
// implementation theo detectEngine() + tập trung logOperation() ở đây (KHÔNG lặp lại trong provider).
const { AppError } = require("../utils/error");
const { logOperation } = require("../utils/logger");
const { getEnvironmentOrThrow, detectEngine } = require("./db-environment.service");
const { buildRancherContext, buildRancherContextAdhoc } = require("./kube.service");
const rancherDbTunnel = require("./providers/rancher/dbtunnel");
const permissionsService = require("./permissions.service");

const postgresQuery = require("./providers/postgres/query");
const postgresSchema = require("./providers/postgres/schema");
const postgresAutocomplete = require("./providers/postgres/autocomplete");
const mongoQuery = require("./providers/mongo/query");
const mongoSchema = require("./providers/mongo/schema");
const mongoAutocomplete = require("./providers/mongo/autocomplete");

function providersFor(envName) {
  const env = getEnvironmentOrThrow(envName);
  const engine = detectEngine(env);
  const providers =
    engine === "mongo"
      ? { query: mongoQuery, schema: mongoSchema, autocomplete: mongoAutocomplete }
      : { query: postgresQuery, schema: postgresSchema, autocomplete: postgresAutocomplete };
  return { env, engine, ...providers };
}

async function runQuery(envName, sql, { page, pageSize, database } = {}) {
  const { env, query } = providersFor(envName);
  try {
    const { kind, ...data } = await query.runQuery(env, envName, sql, { page, pageSize, database });
    logOperation({
      resource: "sql",
      env: envName,
      operation: kind === "write" ? "write" : "query",
      success: true,
      rowCount: data.rowCount,
      ...(data.page !== undefined ? { page: data.page, pageSize: data.pageSize } : {})
    });
    return data;
  } catch (error) {
    logOperation({ resource: "sql", env: envName, operation: "query", success: false, error: error.message });
    throw error instanceof AppError ? error : new AppError(error.message, 400);
  }
}

// { page, pageSize } tuỳ chọn — không truyền vẫn hoạt động (mặc định page=1/pageSize=100, xem
// resolvePaging()/paginateArray() ở từng provider). Response giờ là {page, pageSize, totalRows,
// totalPages, rows} thay vì mảng phẳng trước đây — cây Object Explorer (public/index.html) lazy-load
// từng trang 100 phần tử + nút "Xem thêm" thay vì tải hết 1 lần.
async function listSchemas(envName, { page, pageSize } = {}) {
  const { env, schema } = providersFor(envName);
  try {
    const data = await schema.listSchemas(env, { page, pageSize });
    logOperation({ resource: "sql", env: envName, operation: "list-schemas", success: true, rowCount: data.totalRows });
    return data;
  } catch (error) {
    logOperation({ resource: "sql", env: envName, operation: "list-schemas", success: false, error: error.message });
    throw error instanceof AppError ? error : new AppError(error.message, 400);
  }
}

async function listTables(envName, schemaName, { page, pageSize } = {}) {
  const { env, schema } = providersFor(envName);
  try {
    const data = await schema.listTables(env, schemaName, { page, pageSize });
    logOperation({ resource: "sql", env: envName, operation: "list-tables", success: true, rowCount: data.totalRows });
    return data;
  } catch (error) {
    logOperation({ resource: "sql", env: envName, operation: "list-tables", success: false, error: error.message });
    throw error instanceof AppError ? error : new AppError(error.message, 400);
  }
}

async function listColumns(envName, schemaName, table, { page, pageSize } = {}) {
  const { env, schema } = providersFor(envName);
  try {
    const data = await schema.listColumns(env, schemaName, table, { page, pageSize });
    logOperation({ resource: "sql", env: envName, operation: "list-columns", success: true, rowCount: data.totalRows });
    return data;
  } catch (error) {
    logOperation({ resource: "sql", env: envName, operation: "list-columns", success: false, error: error.message });
    throw error instanceof AppError ? error : new AppError(error.message, 400);
  }
}

async function getFullSchema(envName) {
  const { env, autocomplete } = providersFor(envName);
  try {
    const data = await autocomplete.getFullSchema(env);
    const rowCount = (data.tables || data.collections || []).length;
    logOperation({ resource: "sql", env: envName, operation: "autocomplete-schema", success: true, rowCount });
    return data;
  } catch (error) {
    logOperation({ resource: "sql", env: envName, operation: "autocomplete-schema", success: false, error: error.message });
    throw error instanceof AppError ? error : new AppError(error.message, 400);
  }
}

// Kiểm tra kết nối THẬT (không side-effect, chỉ SELECT 1/Mongo ping) cho icon "Kiểm tra kết nối"
// ở Settings UI (public/shared/settings-modal.js) — trả {success:false, message} thay vì throw khi
// thất bại, để lỗi kết nối (thường gặp, do sai host/token) không lẫn với lỗi hệ thống 4xx/5xx của
// controller. `allowWrite` lấy từ config đã đọc trên server (env.allowWrite thật), KHÔNG phải cờ
// client tự gửi lên — đúng yêu cầu "giá trị được phép ghi phải trả về từ API".
async function testConnection(envName) {
  const { env, query } = providersFor(envName);
  try {
    await query.ping(env);
    logOperation({ resource: "sql", env: envName, operation: "test-connection", success: true });
    return { success: true, allowWrite: Boolean(env.allowWrite) };
  } catch (error) {
    logOperation({ resource: "sql", env: envName, operation: "test-connection", success: false, error: error.message });
    return { success: false, message: error.message || "Kết nối thất bại." };
  }
}

// testConnectionAdhoc — như testConnection() nhưng dùng cho entry Connection String CHƯA "Áp dụng"
// (isNew) ở Settings UI: nhận thẳng dữ liệu từ dòng đang gõ trên frontend (connectionString THẬT có
// host:port, không phải template __HOST__ — khác connectionStringEnvVar đã lưu) thay vì đọc
// config/db-environments.json + process.env. Xem public/shared/settings-modal.js::testConnection().
// Không cache pool/client (mỗi entry chưa lưu chưa có "name" ổn định) — mở tunnel một lần (nếu cần),
// ping, rồi đóng tunnel ngay trong finally (khác nhánh k8s-tunnel đã lưu, tunnel đó được giữ mở/
// idle-cleanup sau 15 phút để tái dùng cho nhiều query).
async function testConnectionAdhoc({ connectionString, rancherKey, rancherUrl, token, clusterId, insecureTLS, namespace, dbHost, dbPort, projectId, existingPodName }) {
  const raw = String(connectionString || "").trim();
  if (!raw) {
    return { success: false, message: "Chưa nhập Connection String." };
  }
  const engine = /^mongodb(\+srv)?:\/\//i.test(raw) ? "mongo" : "postgres";
  const query = engine === "mongo" ? mongoQuery : postgresQuery;

  const useTunnel = Boolean(rancherKey || (rancherUrl && token && clusterId));
  if (!useTunnel) {
    try {
      await query.pingAdhoc(raw);
      logOperation({ resource: "sql", env: "(adhoc)", operation: "test-connection-adhoc", success: true });
      return { success: true };
    } catch (error) {
      logOperation({ resource: "sql", env: "(adhoc)", operation: "test-connection-adhoc", success: false, error: error.message });
      return { success: false, message: error.message || "Kết nối thất bại." };
    }
  }

  if (!namespace || !projectId || !dbHost || !dbPort) {
    return { success: false, message: 'Thiếu "namespace"/"projectId"/"DB Host"/"DB Port" để mở tunnel.' };
  }

  const domainLabel = `db-env-adhoc-test:${rancherKey || clusterId}:${namespace}`;
  let ctx;
  let tunnel;
  try {
    ctx = rancherKey
      ? await buildRancherContext({ domain: domainLabel, clusterName: rancherKey, rancherCluster: rancherKey, namespace, projectId })
      : await buildRancherContextAdhoc({ domain: domainLabel, namespace, projectId, rancherUrl, token, clusterId, insecureTLS });

    if (existingPodName) {
      const access = await permissionsService.checkAccessForCtx(ctx, permissionsService.EXEC_TUNNEL_CHECKS);
      if (!access.writeAccess) {
        throw new AppError(`Token không có quyền "exec" vào pod "${existingPodName}" trong namespace "${access.namespace}".`, 403);
      }
      tunnel = await rancherDbTunnel.openTunnelViaExec(ctx, { podName: existingPodName, dbHost, dbPort });
    } else {
      const access = await permissionsService.checkAccessForCtx(ctx);
      if (!access.writeAccess) {
        throw new AppError(`Token chỉ có quyền xem (view-only) trong namespace "${access.namespace}" — không thể tạo jump pod.`, 403);
      }
      tunnel = await rancherDbTunnel.openTunnel(ctx, { dbHost, dbPort });
    }

    const finalConnectionString = raw.replace(`${dbHost}:${dbPort}`, `127.0.0.1:${tunnel.localPort}`);
    await query.pingAdhoc(finalConnectionString);
    logOperation({ ...ctx, resource: "sql", operation: "test-connection-adhoc", success: true });
    return { success: true };
  } catch (error) {
    if (ctx) {
      logOperation({ ...ctx, resource: "sql", operation: "test-connection-adhoc", success: false, error: error.message });
    }
    return { success: false, message: error.message || "Kết nối thất bại." };
  } finally {
    if (tunnel) {
      try {
        await rancherDbTunnel.closeTunnelServer(tunnel.server);
        if (!existingPodName) {
          await rancherDbTunnel.deleteJumpPod(ctx);
        }
      } catch {
        // best-effort — ưu tiên trả kết quả ping, không để lỗi dọn dẹp che lấp kết quả test
      }
    }
  }
}

module.exports = {
  runQuery,
  listSchemas,
  listTables,
  listColumns,
  getFullSchema,
  testConnection,
  testConnectionAdhoc
};
