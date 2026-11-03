// Tool MCP nhóm META — resolve domain→namespace/cluster, permissions, diagnose, discovery.
const { z } = require("zod");
const { callService } = require("../context.ts");

const resolveService = require("../../../legacy/services/resolve.service.js");
const permissionsService = require("../../../legacy/services/permissions.service.js");
const diagnoseService = require("../../../legacy/services/diagnose.service.js");
const discoveryService = require("../../../legacy/services/discovery.service.js");

function registerK8sMetaTools(server: any): void {
  server.registerTool(
    "k8s_resolve_domain",
    {
      description: "Tra namespace-group: domain → {provider, cluster, namespace, projectId, services}.",
      inputSchema: { domain: z.string().describe("Domain đã cấu hình trong Nhóm Namespace") }
    },
    async ({ domain }: { domain: string }) => callService(() => resolveService.resolveGroup(domain))
  );

  server.registerTool(
    "k8s_check_permissions",
    {
      description: "Kiểm tra quyền (đọc/ghi) hiện có theo cấu hình cho 1 domain.",
      inputSchema: { domain: z.string().describe("Domain đã cấu hình trong Nhóm Namespace") }
    },
    async ({ domain }: { domain: string }) => callService(() => permissionsService.checkAccess(domain))
  );

  server.registerTool(
    "k8s_diagnose",
    {
      description: "Chẩn đoán tổng hợp rollout của 1 service theo domain (readyReplicas/replicas...).",
      inputSchema: {
        domain: z.string().describe("Domain đã cấu hình trong Nhóm Namespace"),
        service: z.string().describe('Key service khai trong Nhóm Namespace, vd "r3svc"/"r3web"')
      }
    },
    async ({ domain, service }: { domain: string; service: string }) =>
      callService(() => diagnoseService.diagnose(domain, service))
  );

  server.registerTool(
    "k8s_discovery_reconcile",
    {
      description: "So khớp cấu hình namespace-group đã lưu với dữ liệu thật trên Rancher cluster.",
      inputSchema: { rancherCluster: z.string().describe("Tên Rancher cluster đã cấu hình (rancher_clusters.name)") }
    },
    async ({ rancherCluster }: { rancherCluster: string }) =>
      callService(() => discoveryService.reconcileCluster(rancherCluster))
  );
}

module.exports = { registerK8sMetaTools };
