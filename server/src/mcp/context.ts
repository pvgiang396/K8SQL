// Helper dùng chung cho mọi tool MCP — xem k8sql/CLAUDE.md mục "MCP server" để biết quyết định
// kiến trúc (tại sao MCP là 1 route HTTP trong CHÍNH sidecar đang chạy, không phải process riêng).
//
// Cú pháp require() thuần (không `import`/`export`) — cùng ràng buộc "Node's native TS
// type-stripping không hỗ trợ cú pháp TS-only/ESM" đã ghi trong bootstrap.ts/config/db.ts.

function isWriteEnabled(): boolean {
  return process.env.K8SQL_MCP_ALLOW_WRITE === "1";
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

// Gọi thẳng 1 hàm service legacy (require("../../legacy/services/xxx.service.js")), dịch kết quả/
// lỗi thành content MCP chuẩn — service legacy vốn ném AppError (có .message tiếng Việt sẵn dùng
// cho response REST), tái dùng nguyên message đó cho AI đọc, không cần dịch lại.
async function callService(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const data = await fn();
    return { content: [{ type: "text", text: toText(data) }] };
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Lỗi: ${error?.message || String(error)}` }],
      isError: true
    };
  }
}

// sql_query (tool READ, luôn bật) chỉ được chạy statement bắt đầu bằng SELECT/WITH — KHÔNG dựa vào
// env.allowWrite của từng connection (field đó dùng cho UI, 1 connection allowWrite=true sẽ khiến
// tool READ mặc định vô tình cho phép ghi nếu không tự chặn riêng ở đây). Áp dụng cho Postgres; với
// Mongo, whitelist method đọc do chính providers/mongo/query.js áp dụng (READ_METHODS luôn cho phép
// bất kể allowWrite) nên không cần chặn thêm ở tầng này.
function assertReadOnlySql(sql: string): void {
  const trimmed = String(sql || "").trim();
  const isMongoCall = /^db\.\w+\./.test(trimmed);
  if (isMongoCall) return; // Mongo tự chặn write method trong providers/mongo/query.js
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error(
      `sql_query chỉ cho phép câu lệnh SELECT/WITH. Dùng tool "sql_mutate" (cần bật ` +
        `K8SQL_MCP_ALLOW_WRITE=1) cho câu lệnh ghi.`
    );
  }
}

module.exports = { isWriteEnabled, callService, assertReadOnlySql };
