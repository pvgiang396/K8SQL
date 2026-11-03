// MCP server tích hợp ngay trong sidecar Express đang chạy (route /mcp), KHÔNG phải process riêng
// — xem k8sql/CLAUDE.md mục "MCP server" cho lý do (secret thật chỉ có trong process.env của CHÍNH
// sidecar này). Đăng ký qua registerExtraRoutes trong bootstrap.ts, giống /internal/*, /native/*.
//
// Stateless mode (1 McpServer + 1 transport MỚI cho mỗi request POST) — đúng pattern chính thức
// của SDK cho use-case không cần giữ session giữa nhiều request (examples/server/
// simpleStatelessStreamableHttp.js trong @modelcontextprotocol/sdk), phù hợp vì mỗi tool call ở
// đây độc lập, không có state hội thoại nào cần giữ giữa các lần gọi.
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");

const { isWriteEnabled } = require("./context.ts");
const { registerK8sReadTools } = require("./tools/k8s-read.ts");
const { registerK8sMetaTools } = require("./tools/k8s-meta.ts");
const { registerSqlReadTools } = require("./tools/sql-read.ts");

function buildServer(): any {
  const server = new McpServer({ name: "k8sql", version: "0.1.0" });

  registerK8sReadTools(server);
  registerK8sMetaTools(server);
  registerSqlReadTools(server);

  // Nhóm WRITE hoàn toàn KHÔNG được đăng ký (không chỉ ẩn) trừ khi bật cờ — client (tools/list)
  // sẽ không bao giờ thấy tool ghi tồn tại nếu cờ tắt, xem k8sql/CLAUDE.md mục "MCP server".
  if (isWriteEnabled()) {
    const { registerK8sWriteTools } = require("./tools/k8s-write.ts");
    const { registerSqlWriteTools } = require("./tools/sql-write.ts");
    registerK8sWriteTools(server);
    registerSqlWriteTools(server);
  }

  return server;
}

function registerMcpRoute(expressApp: import("express").Express): void {
  expressApp.post("/mcp", async (req: import("express").Request, res: import("express").Response) => {
    try {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[k8sql-mcp] Lỗi xử lý request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    }
  });

  // Server không hỗ trợ session (stateless) — không cần stream GET/DELETE, trả 405 đúng theo spec.
  expressApp.get("/mcp", (_req: import("express").Request, res: import("express").Response) => {
    res.writeHead(405).end(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null })
    );
  });
  expressApp.delete("/mcp", (_req: import("express").Request, res: import("express").Response) => {
    res.writeHead(405).end(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null })
    );
  });
}

module.exports = { registerMcpRoute };
