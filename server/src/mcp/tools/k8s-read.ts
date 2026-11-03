// Tool MCP nhóm READ — deployments/services/ingresses/configmaps/secrets/pods/logs. Gọi thẳng
// service legacy (cùng process, có sẵn secret thật trong process.env) — KHÔNG qua controller
// (controller cần req/res giả). Xem k8sql/CLAUDE.md mục "MCP server". Cú pháp require() thuần,
// không `import` — cùng ràng buộc đã ghi trong bootstrap.ts.
const { z } = require("zod");
const { callService } = require("../context.ts");

const deploymentService = require("../../../legacy/services/deployment.service.js");
const serviceService = require("../../../legacy/services/service.service.js");
const ingressService = require("../../../legacy/services/ingress.service.js");
const configMapService = require("../../../legacy/services/configmap.service.js");
const secretService = require("../../../legacy/services/secret.service.js");
const podService = require("../../../legacy/services/pod.service.js");
const logService = require("../../../legacy/services/log.service.js");

const domainField = z.string().describe('Domain đã cấu hình trong Nhóm Namespace (namespace_groups), vd "dvccddemo.vnptigate.vn"');

function registerK8sReadTools(server: any): void {
  server.registerTool(
    "k8s_list_deployments",
    {
      description: "Liệt kê Deployment trong namespace ứng với domain đã cấu hình.",
      inputSchema: { domain: domainField }
    },
    async ({ domain }: { domain: string }) => callService(() => deploymentService.listDeployments(domain))
  );

  server.registerTool(
    "k8s_describe_deployment",
    {
      description: "Mô tả chi tiết + YAML 1 Deployment.",
      inputSchema: { domain: domainField, deployment: z.string().describe("Tên Deployment") }
    },
    async ({ domain, deployment }: { domain: string; deployment: string }) =>
      callService(async () => {
        const [describe, yaml] = await Promise.all([
          deploymentService.describeDeployment(domain, deployment),
          deploymentService.getDeploymentYaml(domain, deployment)
        ]);
        return { describe, yaml };
      })
  );

  server.registerTool(
    "k8s_list_services",
    {
      description: "Liệt kê Service trong namespace ứng với domain.",
      inputSchema: { domain: domainField }
    },
    async ({ domain }: { domain: string }) => callService(() => serviceService.listServices(domain))
  );

  server.registerTool(
    "k8s_describe_service",
    {
      description: "Mô tả chi tiết + YAML 1 Service.",
      inputSchema: { domain: domainField, service: z.string().describe("Tên Service") }
    },
    async ({ domain, service }: { domain: string; service: string }) =>
      callService(async () => {
        const [describe, yaml] = await Promise.all([
          serviceService.describeService(domain, service),
          serviceService.getServiceYaml(domain, service)
        ]);
        return { describe, yaml };
      })
  );

  server.registerTool(
    "k8s_list_ingresses",
    {
      description: "Liệt kê Ingress trong namespace ứng với domain.",
      inputSchema: { domain: domainField }
    },
    async ({ domain }: { domain: string }) => callService(() => ingressService.listIngresses(domain))
  );

  server.registerTool(
    "k8s_describe_ingress",
    {
      description: "Mô tả chi tiết + YAML 1 Ingress (host, path, backend).",
      inputSchema: { domain: domainField, ingress: z.string().describe("Tên Ingress") }
    },
    async ({ domain, ingress }: { domain: string; ingress: string }) =>
      callService(async () => {
        const [describe, yaml] = await Promise.all([
          ingressService.describeIngress(domain, ingress),
          ingressService.getIngressYaml(domain, ingress)
        ]);
        return { describe, yaml };
      })
  );

  server.registerTool(
    "k8s_read_configmap",
    {
      description: "Đọc key/value + YAML của 1 ConfigMap.",
      inputSchema: { domain: domainField, configMap: z.string().describe("Tên ConfigMap") }
    },
    async ({ domain, configMap }: { domain: string; configMap: string }) =>
      callService(async () => {
        const [data, yaml] = await Promise.all([
          configMapService.readConfigMap(domain, configMap),
          configMapService.getConfigMapYaml(domain, configMap)
        ]);
        return { data, yaml };
      })
  );

  server.registerTool(
    "k8s_read_secret",
    {
      description: "Đọc danh sách key + YAML của 1 Secret (giá trị mask/base64 theo hành vi route gốc, không giải mã thêm).",
      inputSchema: { domain: domainField, secret: z.string().describe("Tên Secret") }
    },
    async ({ domain, secret }: { domain: string; secret: string }) =>
      callService(async () => {
        const [data, yaml] = await Promise.all([
          secretService.readSecret(domain, secret),
          secretService.getSecretYaml(domain, secret)
        ]);
        return { data, yaml };
      })
  );

  server.registerTool(
    "k8s_list_pods",
    {
      description: "Liệt kê Pod trong namespace ứng với domain.",
      inputSchema: { domain: domainField }
    },
    async ({ domain }: { domain: string }) => callService(() => podService.listPods(domain))
  );

  server.registerTool(
    "k8s_describe_pod",
    {
      description: "Mô tả chi tiết + trạng thái 1 Pod.",
      inputSchema: { domain: domainField, pod: z.string().describe("Tên Pod") }
    },
    async ({ domain, pod }: { domain: string; pod: string }) =>
      callService(async () => {
        const [describe, status] = await Promise.all([
          podService.describePod(domain, pod),
          podService.getPodStatus(domain, pod)
        ]);
        return { describe, status };
      })
  );

  server.registerTool(
    "k8s_search_logs",
    {
      description: "Tìm log theo từ khoá trong 1 pod cụ thể hoặc mọi pod của namespace.",
      inputSchema: {
        domain: domainField,
        pod: z.string().optional().describe("Tên pod cụ thể — bỏ trống để quét mọi pod trong namespace"),
        container: z.string().optional().describe("Tên container (nếu pod có nhiều container)"),
        keyword: z.string().optional().describe("Từ khoá lọc dòng log"),
        tailLines: z.number().int().positive().optional().describe("Số dòng cuối lấy mỗi pod"),
        previous: z.boolean().optional().describe("Lấy log của container instance trước (đã restart)")
      }
    },
    async ({ domain, pod, container, keyword, tailLines, previous }: any) =>
      callService(() => logService.searchLogs({ domain, pod, container, keyword, tailLines, previous }))
  );
}

module.exports = { registerK8sReadTools };
