// Tool MCP nhóm SQL WRITE — CHỈ đăng ký khi K8SQL_MCP_ALLOW_WRITE=1. Không có tool tunnel riêng
// (quyết định đã chốt với user) — db.service.js tự mở tunnel ngầm khi cần, giống sql_query.
const { z } = require("zod");
const { callService } = require("../context.ts");

const dbService = require("../../../legacy/services/db.service.js");

function registerSqlWriteTools(server: any): void {
  server.registerTool(
    "sql_mutate",
    {
      description:
        "CẢNH BÁO: chạy câu lệnh GHI (Postgres: INSERT/UPDATE/DELETE; Mongo: insertOne/updateOne/deleteOne/...). " +
        "Chỉ hoạt động nếu connection đó bật allowWrite=true (cấu hình sẵn cho từng connection, không thể ép qua tool này) — rủi ro cao, KHÔNG hoàn tác được.",
      inputSchema: {
        env: z.string().describe("Tên connection đã cấu hình trong SQL Tool (db_environments.name)"),
        sql: z.string().describe('Câu lệnh ghi (Postgres) hoặc "db.<collection>.insertOne/updateOne/deleteOne(...)" (Mongo)'),
        page: z.number().int().positive().optional()
      }
    },
    async ({ env, sql, page }: { env: string; sql: string; page?: number }) =>
      callService(() => dbService.runQuery(env, sql, { page }))
  );
}

module.exports = { registerSqlWriteTools };
