const express = require("express");

// Route table PORT NGUYÊN VẸN từ k8sctl/app.js — không sửa logic controller/service nào ở đây.
// KHÁC BIỆT so với bản gốc:
//   - Không tự nạp .env/dotenv.config() ở đây — process.env đã được envShim (server/src/secrets)
//     hoặc bootstrap Phase 1 tạm thời set xong TRƯỚC khi module này được require (giữ đúng ràng
//     buộc "nạp env trước khi require controller/service" ghi trong CLAUDE.md gốc, chỉ đổi nguồn
//     nạp từ file .env sang SQLite+keychain).
//   - Không tự app.listen() ở cuối file — do bootstrap.ts gọi để còn set port/host theo cấu hình
//     k8sql (port mặc định 4210, khác k8sctl 3210) và emit sự kiện "ready" cho sidecar lifecycle.
//   - Export createApp({publicDir}) thay vì app đã cấu hình sẵn — sau khi đóng gói SEA, __dirname
//     không còn trỏ đúng vị trí file gốc trên đĩa (SEA bundle mọi thứ vào 1 file), nên đường dẫn
//     static/public phải do bootstrap.ts tính (qua process.execPath) rồi truyền vào, không tự suy
//     ra từ __dirname trong file này nữa.
//   - Thêm POST /internal/shutdown (không có ở k8sctl gốc) để Tauri gọi graceful shutdown thay vì
//     hard-kill process ngay — dọn tunnel DB đang mở qua dbtunnel.service.js trước khi thoát.

const deploymentController = require("./controllers/deployment.controller");
const serviceController = require("./controllers/service.controller");
const ingressController = require("./controllers/ingress.controller");
const configMapController = require("./controllers/configmap.controller");
const podController = require("./controllers/pod.controller");
const logController = require("./controllers/log.controller");
const secretController = require("./controllers/secret.controller");
const discoveryController = require("./controllers/discovery.controller");
const resolveController = require("./controllers/resolve.controller");
const verifyController = require("./controllers/verify.controller");
const diagnoseController = require("./controllers/diagnose.controller");
const provisionController = require("./controllers/provision.controller");
const dbTunnelController = require("./controllers/dbtunnel.controller");
const permissionsController = require("./controllers/permissions.controller");
const dbEnvironmentController = require("./controllers/db-environment.controller");
const dbQueryController = require("./controllers/db-query.controller");
const dbSchemaController = require("./controllers/db-schema.controller");
const dbConfigController = require("./controllers/db-config.controller");
const settingsController = require("./controllers/settings.controller");
const { errorMiddleware } = require("./utils/error");

function createApp({ publicDir, registerExtraRoutes }) {
  const app = express();
  app.use(express.json());

app.get("/health", async (_req, res) => {
  res.json({ success: true, message: "ok" });
});

app.get("/deployments", deploymentController.listDeployments);
app.get("/deployments/describe", deploymentController.describeDeployment);
app.get("/deployments/yaml", deploymentController.getDeploymentYaml);
app.post("/deployments/restart", deploymentController.restartDeployment);
app.post("/deployments/scale", deploymentController.scaleDeployment);
app.post("/deployments/set-image", deploymentController.setDeploymentImage);
app.post("/deployments/delete", deploymentController.deleteDeployment);

app.get("/services", serviceController.listServices);
app.get("/services/describe", serviceController.describeService);
app.get("/services/yaml", serviceController.getServiceYaml);
app.post("/services/delete", serviceController.deleteService);

app.get("/ingresses", ingressController.listIngresses);
app.get("/ingresses/describe", ingressController.describeIngress);
app.get("/ingresses/yaml", ingressController.getIngressYaml);
app.post("/ingresses/apply", ingressController.upsertIngress);
app.post("/ingresses/annotate", ingressController.annotateIngress);
app.post("/ingresses/delete", ingressController.deleteIngress);

app.get("/configmaps/read", configMapController.readConfigMap);
app.get("/configmaps/yaml", configMapController.getConfigMapYaml);
app.post("/configmaps/update", configMapController.updateConfigMapKey);
app.post("/configmaps/delete", configMapController.deleteConfigMap);

app.get("/pods", podController.listPods);
app.get("/pods/for-db-env", podController.listPodsForDbEnv);
app.post("/pods/for-db-env-adhoc", podController.listPodsForDbEnvAdhoc);
app.get("/pods/describe", podController.describePod);
app.get("/pods/status", podController.getPodStatus);
app.post("/pods/delete", podController.deletePod);
app.post("/pods/restart", podController.restartPod);

app.post("/logs/search", logController.searchLogs);

app.get("/secrets/read", secretController.readSecret);
app.get("/secrets/yaml", secretController.getSecretYaml);

app.get("/discovery/reconcile", discoveryController.reconcile);

app.get("/resolve", resolveController.resolveGroup);

app.post("/verify-deploy", verifyController.verifyDeploy);

app.get("/diagnose", diagnoseController.diagnose);

app.post("/provision/apply-yaml", provisionController.applyYaml);
app.post("/provision/add-group", provisionController.addGroup);
app.get("/provision/readiness", provisionController.readiness);

app.post("/db-tunnel/open", dbTunnelController.openTunnel);
app.post("/db-tunnel/close", dbTunnelController.closeTunnel);
app.post("/db-tunnel/open-env", dbTunnelController.openTunnelForEnv);
app.post("/db-tunnel/close-env", dbTunnelController.closeTunnelForEnv);

app.get("/permissions", permissionsController.checkAccess);

app.get("/sql/environments", dbEnvironmentController.listEnvironments);
app.get("/sql/schemas", dbSchemaController.listSchemas);
app.get("/sql/tables", dbSchemaController.listTables);
app.get("/sql/columns", dbSchemaController.listColumns);
app.get("/sql/autocomplete-schema", dbSchemaController.getAutocompleteSchema);
app.post("/sql/query", dbQueryController.query);
app.get("/sql/config/export", dbConfigController.exportConfig);
// Body là file .sqlite nhị phân (srs/nangcapk8sql/v1.md #2) — express.json() global (dòng trên)
// chỉ parse khi Content-Type: application/json nên không đụng route này; raw() riêng cho đúng
// Content-Type octet-stream frontend gửi lên.
app.post(
  "/sql/config/import",
  express.raw({ type: "application/octet-stream", limit: "20mb" }),
  dbConfigController.importConfig
);
// Route MỚI (không có ở k8sctl gốc) — biến thể path-based cho WebView Tauri, xem comment
// exportConfigToPath/importConfigFromPath trong db-config.controller.js.
app.post("/sql/config/export-to-path", dbConfigController.exportConfigToPath);
app.post("/sql/config/import-from-path", dbConfigController.importConfigFromPath);

app.get("/settings/current", settingsController.getCurrentInstallInfo);
app.post("/settings/apply", settingsController.applySettings);
app.post("/settings/browse-directory", settingsController.browseDirectory);
app.get("/settings/rancher-clusters", settingsController.listRancherClusters);
app.post("/settings/rancher-clusters", settingsController.saveRancherClusters);
app.post("/settings/rancher-clusters/reveal-token", settingsController.revealRancherToken);
app.get("/settings/rancher-projects", settingsController.listRancherProjects);
app.get("/settings/rancher-namespaces", settingsController.listRancherNamespaces);
app.get("/settings/rancher-services", settingsController.listRancherServices);
app.get("/settings/rancher-deployments", settingsController.listRancherDeployments);
app.post("/settings/rancher-cluster-options", settingsController.listRancherClusterOptions);
app.post("/settings/rancher-projects-adhoc", settingsController.listRancherProjectsAdhoc);
app.post("/settings/rancher-namespaces-adhoc", settingsController.listRancherNamespacesAdhoc);
app.post("/settings/rancher-services-adhoc", settingsController.listRancherServicesAdhoc);
app.get("/settings/namespace-groups", settingsController.listNamespaceGroups);
app.post("/settings/namespace-groups", settingsController.saveNamespaceGroups);
app.get("/settings/db-environments", settingsController.listDbEnvironments);
app.post("/settings/db-environments", settingsController.saveDbEnvironments);
app.post("/settings/db-environments/reveal-value", settingsController.revealDbEnvironmentValue);
app.post("/settings/db-environments/test", settingsController.testDbConnection);
app.post("/settings/db-environments/test-adhoc", settingsController.testDbConnectionAdhoc);

// Tauri gọi trước khi kill process. dbtunnel.service.js (legacy, không sửa) chỉ export
// closeTunnel(domain)/closeTunnelForDbEnv(name) theo từng key, không có API "đóng tất cả" — tunnel
// mồ côi (nếu có) vẫn được dọn qua idle-cleanup có sẵn (~15 phút không dùng, xem services/dbtunnel.service.js).
// TODO(Phase 3+): cân nhắc thêm export closeAllTunnels() vào services MỚI (không sửa file legacy)
// nếu cần dọn tức thời khi thoát app.
app.post("/internal/shutdown", async (_req, res) => {
  res.json({ success: true, message: "shutting down" });
  setTimeout(() => process.exit(0), 100);
});

// Hook cho route MỚI (không có ở k8sctl gốc, vd /internal/import-k8sctl-config) — bootstrap.ts
// truyền vào để đăng ký TRƯỚC static/404 handler bên dưới (đăng ký sau sẽ không bao giờ khớp, vì
// middleware 404 chặn mọi path đứng trước nó).
if (typeof registerExtraRoutes === "function") {
  registerExtraRoutes(app);
}

// UI web nhẹ (chọn connection, SQL editor có autocomplete, cây Object Explorer, xem kết quả) —
// không build step, gọi same-origin tới đúng các API /sql/* ở trên. Đặt SAU mọi route API, TRƯỚC
// 404 handler. publicDir do bootstrap.ts tính (dev: cạnh legacy/, SEA: cạnh binary) — xem comment
// đầu file.
app.use(express.static(publicDir));

app.use((_req, res) => {
  res.status(404).json({ success: false, message: "Endpoint not found." });
});

app.use(errorMiddleware);

  return app;
}

module.exports = { createApp };
