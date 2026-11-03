// Tool MCP nhóm SQL READ — environments/schemas/tables/columns/primary-key/autocomplete-schema/
// query(SELECT). DB tunnel tới pod Postgres/MongoDB được db.service.js tự mở ngầm khi cần (xem
// k8sql/CLAUDE.md) — không có tool tunnel riêng, theo quyết định đã chốt với user.
const { z } = require("zod");
const { callService, assertReadOnlySql } = require("../context.ts");

const dbService = require("../../../legacy/services/db.service.js");
const dbEnvironmentService = require("../../../legacy/services/db-environment.service.js");

const envField = z.string().describe("Tên connection đã cấu hình trong SQL Tool (db_environments.name)");

function registerSqlReadTools(server: any): void {
  server.registerTool(
    "sql_list_environments",
    {
      description: "Liệt kê connection SQL đã cấu hình (tên, engine, allowWrite, mô tả) — KHÔNG trả connection string thật.",
      inputSchema: {}
    },
    async () => callService(() => Promise.resolve(dbEnvironmentService.listEnvironmentsPublic()))
  );

  server.registerTool(
    "sql_list_schemas",
    {
      description: "Liệt kê schema (Postgres) của 1 connection.",
      inputSchema: { env: envField }
    },
    async ({ env }: { env: string }) => callService(() => dbService.listSchemas(env))
  );

  server.registerTool(
    "sql_list_tables",
    {
      description: "Liệt kê bảng trong 1 schema.",
      inputSchema: { env: envField, schema: z.string().describe("Tên schema") }
    },
    async ({ env, schema }: { env: string; schema: string }) => callService(() => dbService.listTables(env, schema))
  );

  server.registerTool(
    "sql_list_columns",
    {
      description: "Liệt kê cột của 1 bảng.",
      inputSchema: { env: envField, schema: z.string().describe("Tên schema"), table: z.string().describe("Tên bảng") }
    },
    async ({ env, schema, table }: { env: string; schema: string; table: string }) =>
      callService(() => dbService.listColumns(env, schema, table))
  );

  server.registerTool(
    "sql_get_primary_key",
    {
      description: "Lấy tên cột khoá chính của 1 bảng.",
      inputSchema: { env: envField, schema: z.string().describe("Tên schema"), table: z.string().describe("Tên bảng") }
    },
    async ({ env, schema, table }: { env: string; schema: string; table: string }) =>
      callService(() => dbService.getPrimaryKeyColumns(env, schema, table))
  );

  server.registerTool(
    "sql_get_autocomplete_schema",
    {
      description: "Lấy toàn bộ schema (mọi bảng/cột) của 1 connection — dùng để hiểu cấu trúc DB trước khi viết query.",
      inputSchema: { env: envField }
    },
    async ({ env }: { env: string }) => callService(() => dbService.getFullSchema(env))
  );

  server.registerTool(
    "sql_query",
    {
      description:
        "Chạy câu lệnh ĐỌC (Postgres: SELECT/WITH; Mongo: db.<collection>.find/aggregate/...). " +
        "KHÔNG chạy được câu lệnh ghi dù connection có allowWrite=true — dùng tool sql_mutate (cần bật cờ) cho việc ghi.",
      inputSchema: {
        env: envField,
        sql: z.string().describe('Câu SELECT/WITH (Postgres) hoặc lệnh dạng "db.<collection>.find(...)" (Mongo)'),
        page: z.number().int().positive().optional().describe("Trang kết quả (phân trang)")
      }
    },
    async ({ env, sql, page }: { env: string; sql: string; page?: number }) =>
      callService(async () => {
        assertReadOnlySql(sql);
        return dbService.runQuery(env, sql, { page });
      })
  );
}

module.exports = { registerSqlReadTools };
