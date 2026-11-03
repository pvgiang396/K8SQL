// Tool MCP nhóm WRITE (Kubernetes) — CHỈ đăng ký khi K8SQL_MCP_ALLOW_WRITE=1 (server.ts kiểm tra
// trước khi require file này, xem context.ts::isWriteEnabled()). Thao tác ghi provider rancher
// "chưa test đầy đủ" theo docs/team-notes.md (r3workspace) — mô tả tool nêu rõ rủi ro.
const { z } = require("zod");
const { callService } = require("../context.ts");

const deploymentService = require("../../../legacy/services/deployment.service.js");
const serviceService = require("../../../legacy/services/service.service.js");
const ingressService = require("../../../legacy/services/ingress.service.js");
const configMapService = require("../../../legacy/services/configmap.service.js");
const podService = require("../../../legacy/services/pod.service.js");

const domainField = z.string().describe("Domain đã cấu hình trong Nhóm Namespace (namespace_groups)");

function registerK8sWriteTools(server: any): void {
  server.registerTool(
    "k8s_restart_deployment",
    {
      description: "CẢNH BÁO: khởi động lại (rollout restart) 1 Deployment — rủi ro thấp, thao tác thường dùng.",
      inputSchema: { domain: domainField, deployment: z.string().describe("Tên Deployment") }
    },
    async ({ domain, deployment }: { domain: string; deployment: string }) =>
      callService(() => deploymentService.restartDeployment(domain, deployment))
  );

  server.registerTool(
    "k8s_scale_deployment",
    {
      description: "CẢNH BÁO: đổi số replicas 1 Deployment — rủi ro trung bình.",
      inputSchema: {
        domain: domainField,
        deployment: z.string().describe("Tên Deployment"),
        replicas: z.number().int().nonnegative().describe("Số replicas mới")
      }
    },
    async ({ domain, deployment, replicas }: { domain: string; deployment: string; replicas: number }) =>
      callService(() => deploymentService.scaleDeployment(domain, deployment, replicas))
  );

  server.registerTool(
    "k8s_set_deployment_image",
    {
      description: "CẢNH BÁO: đổi image 1 Deployment — rủi ro cao, đổi sai domain/image có thể sập service production.",
      inputSchema: {
        domain: domainField,
        deployment: z.string().describe("Tên Deployment"),
        image: z.string().describe("Image mới, PHẢI có đầy đủ registry prefix, vd registry.vnptigate.vn/igate/r3svc:tag"),
        container: z.string().optional().describe("Tên container nếu Deployment có nhiều container")
      }
    },
    async ({ domain, deployment, image, container }: { domain: string; deployment: string; image: string; container?: string }) =>
      callService(() => deploymentService.setDeploymentImage(domain, deployment, image, container))
  );

  server.registerTool(
    "k8s_update_configmap",
    {
      description: "CẢNH BÁO: cập nhật 1 key trong ConfigMap — provider rancher chưa test đầy đủ theo team-notes, tự verify kỹ trước khi dùng.",
      inputSchema: {
        domain: domainField,
        configMap: z.string().describe("Tên ConfigMap"),
        key: z.string().describe("Tên key"),
        value: z.string().describe("Giá trị mới")
      }
    },
    async ({ domain, configMap, key, value }: { domain: string; configMap: string; key: string; value: string }) =>
      callService(() => configMapService.updateConfigMapKey(domain, configMap, key, value))
  );

  server.registerTool(
    "k8s_apply_ingress",
    {
      description: "CẢNH BÁO: tạo/cập nhật 1 Ingress hoàn toàn mới. KHÔNG dùng cho Ingress đã có route khác trên cùng host (dễ conflict path, xem sự cố #43 team-notes) — dùng k8s_annotate_ingress để chỉ thêm annotation cho Ingress có sẵn.",
      inputSchema: {
        domain: domainField,
        name: z.string().describe("Tên Ingress"),
        host: z.string().describe("Host"),
        paths: z.array(z.string()).min(1).describe("Danh sách path"),
        rewriteTarget: z.string().optional().describe("nginx.ingress.kubernetes.io/rewrite-target"),
        backendServiceName: z.string().describe("Tên Service backend"),
        backendServicePort: z.number().int().positive().describe("Port Service backend"),
        proxyReadTimeoutSec: z.number().int().positive().optional().describe("proxy-read-timeout (giây)"),
        proxySendTimeoutSec: z.number().int().positive().optional().describe("proxy-send-timeout (giây)")
      }
    },
    async (args: any) =>
      callService(() =>
        ingressService.upsertIngress(args.domain, {
          name: args.name,
          host: args.host,
          paths: args.paths,
          rewriteTarget: args.rewriteTarget,
          backendServiceName: args.backendServiceName,
          backendServicePort: args.backendServicePort,
          proxyReadTimeoutSec: args.proxyReadTimeoutSec,
          proxySendTimeoutSec: args.proxySendTimeoutSec
        })
      )
  );

  server.registerTool(
    "k8s_annotate_ingress",
    {
      description: "Merge thêm annotation vào 1 Ingress HIỆN CÓ — KHÔNG đụng rules/route hiện có, an toàn hơn k8s_apply_ingress cho Ingress đang phục vụ traffic thật.",
      inputSchema: {
        domain: domainField,
        ingress: z.string().describe("Tên Ingress"),
        annotations: z.record(z.string()).describe("Object annotation key→value cần merge thêm")
      }
    },
    async ({ domain, ingress, annotations }: { domain: string; ingress: string; annotations: Record<string, string> }) =>
      callService(() => ingressService.annotateIngress(domain, ingress, annotations))
  );

  server.registerTool(
    "k8s_delete_resource",
    {
      description: "CẢNH BÁO: xoá 1 resource Kubernetes — rủi ro cao nhất, KHÔNG hoàn tác được.",
      inputSchema: {
        domain: domainField,
        kind: z.enum(["deployment", "service", "ingress", "configmap", "pod"]).describe("Loại resource cần xoá"),
        name: z.string().describe("Tên resource")
      }
    },
    async ({ domain, kind, name }: { domain: string; kind: string; name: string }) =>
      callService(() => {
        switch (kind) {
          case "deployment":
            return deploymentService.deleteDeployment(domain, name);
          case "service":
            return serviceService.deleteService(domain, name);
          case "ingress":
            return ingressService.deleteIngress(domain, name);
          case "configmap":
            return configMapService.deleteConfigMap(domain, name);
          case "pod":
            return podService.deletePod(domain, name);
          default:
            throw new Error(`kind không hợp lệ: ${kind}`);
        }
      })
  );

  server.registerTool(
    "k8s_restart_pod",
    {
      description: "CẢNH BÁO: xoá 1 Pod để Kubernetes tự tạo lại (restart) — thường dùng khi pod treo, rủi ro thấp nếu Deployment có nhiều replicas.",
      inputSchema: { domain: domainField, pod: z.string().describe("Tên Pod") }
    },
    async ({ domain, pod }: { domain: string; pod: string }) => callService(() => podService.restartPod(domain, pod))
  );
}

module.exports = { registerK8sWriteTools };
