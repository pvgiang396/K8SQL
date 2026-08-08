"use strict";

// Logic dùng chung cho cả 2 provider (kubeconfig/rancher) — cả 2 chỉ khác nhau ở cách dựng
// `coreV1`/`kc` (raw kubeconfig file vs KubeConfig tổng hợp trỏ Rancher cluster-proxy), phần
// tạo jump pod + port-forward giống hệt nhau vì đều dùng chung @kubernetes/client-node.

const net = require("net");
const { Writable } = require("stream");
const { AppError, extractK8sError } = require("../../utils/error");

// Không có tag = ngầm định "latest", bị chặn ở cluster có policy Kyverno "disallow-latest-tag".
// alpine/socat cũng bị chặn hoàn toàn ở cluster có policy "restrict-image-registry" (chỉ cho
// kéo image từ registry nội bộ) — case thật đã gặp, xem "Giới hạn cần biết" trong CLAUDE.md.
// Override qua biến môi trường JUMP_POD_IMAGE khi cluster đích yêu cầu registry nội bộ.
const JUMP_POD_IMAGE = process.env.JUMP_POD_IMAGE || "alpine/socat:1.8.0.1";
const JUMP_POD_PORT = 5432;
const POD_READY_TIMEOUT_MS = 30000;
const POD_READY_POLL_MS = 1000;

function jumpPodName(domain) {
  const slug = String(domain)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return `k8sctl-db-tunnel-${slug}`;
}

// avoidNodeHostnames: danh sách hostname cần tránh khi schedule (vd node dành riêng cho
// ingress/dns — đã xác nhận thật trên 1 cluster thực tế đã gặp: node có label
// `app: ingress`/`role: dns` khiến CNI treo vô thời hạn ở ContainerCreating cho pod ứng dụng
// thường, trong khi mọi node "thường" khác lên Running trong ~11s. Khai qua field
// `db.avoidNodeHostnames` trong namespaces.json — chỉ nhóm nào gặp vấn đề mới cần khai.
// Dùng đúng 1 matchExpression NotIn trên `kubernetes.io/hostname` (nhãn luôn tồn tại ở mọi node)
// — đã verify: kết hợp NotIn trên nhãn tuỳ biến (vd app/role) không loại trừ đúng như kỳ vọng
// trên cluster này (tất cả node bị coi "không khớp"), nhưng NotIn trên hostname hoạt động đúng.
// requireNodeHostnames: ngược lại avoidNodeHostnames — ép pod CHỈ được schedule vào 1 trong các
// node liệt kê (operator "In"). Case thật đã gặp: firewall ngoài cluster whitelist theo IP node cụ
// thể (không phải theo cả cluster/namespace) — 1 node đã được mở route tới DB, node khác thì chưa.
// Không dùng cùng lúc với avoidNodeHostnames (2 field loại trừ nhau, ưu tiên requireNodeHostnames
// nếu cả 2 đều khai vì ràng buộc chặt hơn).
function buildPodManifest(name, namespace, dbHost, dbPort, avoidNodeHostnames = [], requireNodeHostnames = []) {
  const nodeSelectorTerm = requireNodeHostnames.length
    ? { matchExpressions: [{ key: "kubernetes.io/hostname", operator: "In", values: requireNodeHostnames }] }
    : avoidNodeHostnames.length
      ? { matchExpressions: [{ key: "kubernetes.io/hostname", operator: "NotIn", values: avoidNodeHostnames }] }
      : null;

  const affinity = nodeSelectorTerm
    ? {
        nodeAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: {
            nodeSelectorTerms: [nodeSelectorTerm]
          }
        }
      }
    : undefined;

  return {
    metadata: { name, namespace, labels: { app: "k8sctl-db-tunnel" } },
    spec: {
      ...(affinity ? { affinity } : {}),
      // securityContext pod+container tuân thủ chuẩn PodSecurity "restricted" — bắt buộc trên
      // cluster nào enforce PSA restricted qua label namespace (case thật đã gặp: cluster
      // platform.idg.vnpt.vn từ chối 403 pod thiếu securityContext này). Không set thì vẫn chạy
      // bình thường trên cluster không enforce PSA nên áp dụng chung, không cần cấu hình riêng
      // theo cluster. UID/GID 65534 (nobody) — alpine/socat không cần root để bind port 5432.
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 65534,
        runAsGroup: 65534,
        // fsGroup bắt buộc trong khoảng 2000-65534 trên cluster có policy Kyverno
        // "check-userid-fsgroup" — 65534 (nobody) đã nằm trong range nên tái dùng luôn.
        fsGroup: 65534,
        seccompProfile: { type: "RuntimeDefault" }
      },
      containers: [
        {
          name: "socat",
          image: JUMP_POD_IMAGE,
          // Policy Kyverno "image-pull-policy" đòi IfNotPresent tường minh (không nhận default).
          imagePullPolicy: "IfNotPresent",
          args: [`TCP-LISTEN:${JUMP_POD_PORT},fork,reuseaddr`, `TCP:${dbHost}:${dbPort}`],
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ["ALL"] },
            runAsNonRoot: true,
            runAsUser: 65534,
            // socat không cần viết vào rootfs — bật readOnlyRootFilesystem thoả policy Kyverno
            // "require-ro-rootfs" mà không ảnh hưởng hành vi (chỉ forward TCP, không ghi file).
            readOnlyRootFilesystem: true,
            seccompProfile: { type: "RuntimeDefault" }
          },
          // Khai tường minh — nếu bỏ trống, namespace có LimitRange sẽ tự áp default (thường
          // 1-2 CPU/pod), dễ vượt ResourceQuota còn lại của namespace dù pod thật sự chỉ forward
          // TCP (gần như không tốn CPU/RAM). Case thật đã gặp: namespace applications-test chỉ còn
          // dư ~0.6 CPU trong quota, default limit 2 CPU khiến tạo jump pod bị từ chối 403
          // "exceeded quota". 100m CPU/64Mi đủ dư cho socat.
          resources: {
            requests: { cpu: "20m", memory: "16Mi" },
            limits: { cpu: "100m", memory: "64Mi" }
          }
        }
      ],
      restartPolicy: "Always"
    }
  };
}

async function ensureJumpPod({ coreV1, namespace, domain, dbHost, dbPort, avoidNodeHostnames, requireNodeHostnames }) {
  const name = jumpPodName(domain);

  try {
    const existing = await coreV1.readNamespacedPod({ name, namespace });
    const phase = existing?.status?.phase;
    if (phase && phase !== "Failed" && phase !== "Succeeded") {
      return name;
    }
    await coreV1.deleteNamespacedPod({ name, namespace });
  } catch (error) {
    const { statusCode } = extractK8sError(error);
    if (Number(statusCode) !== 404) {
      throw new AppError(error.body?.message || "Không thể kiểm tra jump pod.", Number(statusCode) || 502);
    }
  }

  await coreV1.createNamespacedPod({
    namespace,
    body: buildPodManifest(name, namespace, dbHost, dbPort, avoidNodeHostnames, requireNodeHostnames)
  });

  const deadline = Date.now() + POD_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const pod = await coreV1.readNamespacedPod({ name, namespace });
      if (pod?.status?.phase === "Running") {
        return name;
      }
    } catch (error) {
      // 404 ngay sau createNamespacedPod() — cluster-proxy Rancher đọc qua cache informer riêng,
      // có thể chưa kịp đồng bộ object vừa tạo trong 1-2 lần poll đầu (đã gặp thật). Coi như "chưa
      // sẵn sàng", tiếp tục chờ tới deadline thay vì văng lỗi ngay ở lần đọc đầu tiên. Lỗi KHÁC 404
      // (mất quyền, network...) vẫn nên tiếp tục retry tới deadline — timeout cuối cùng đã có message
      // rõ ràng, không cần phân biệt loại lỗi ở đây.
      const { statusCode } = extractK8sError(error);
      if (Number(statusCode) !== 404) {
        // Lỗi không phải "chưa tồn tại" (vd mất quyền đọc) — không có lý do gì đợi tiếp, báo ngay.
        throw new AppError(error.body?.message || "Không thể kiểm tra trạng thái jump pod.", Number(statusCode) || 502);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POD_READY_POLL_MS));
  }
  throw new AppError("Jump pod không chuyển sang trạng thái Running trong thời gian chờ.", 504, { podName: name });
}

async function openPortForward(kc, namespace, podName) {
  const k8s = await import("@kubernetes/client-node").then((moduleValue) => moduleValue.default || moduleValue);
  const forward = new k8s.PortForward(kc);

  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      forward.portForward(namespace, podName, [JUMP_POD_PORT], socket, null, socket).catch((error) => {
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// coreV1/kc: client @kubernetes/client-node đã sẵn sàng trỏ đúng cluster (raw kubeconfig hoặc
// KubeConfig tổng hợp trỏ Rancher cluster-proxy) — provider caller chịu trách nhiệm dựng đúng.
async function openTunnel({ coreV1, kc, namespace, domain, dbHost, dbPort, avoidNodeHostnames, requireNodeHostnames }) {
  if (!dbHost || !dbPort) {
    throw new AppError(`Nhóm chưa khai field "db" (host/port) trong namespaces.json cho domain: ${domain}`, 400);
  }
  const podName = await ensureJumpPod({ coreV1, namespace, domain, dbHost, dbPort, avoidNodeHostnames, requireNodeHostnames });
  const server = await openPortForward(kc, namespace, podName);
  const localPort = server.address().port;
  return { podName, server, localPort };
}

async function closeTunnelServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

async function deleteJumpPod({ coreV1, namespace, domain }) {
  const name = jumpPodName(domain);
  try {
    await coreV1.deleteNamespacedPod({ name, namespace });
  } catch (error) {
    const { statusCode } = extractK8sError(error);
    if (Number(statusCode) !== 404) {
      throw error;
    }
  }
}

// ---- Exec-relay tunnel: dùng 1 pod CÓ SẴN (không tạo/xoá pod) — xem dbEnv.existingPodName ở
// db-environments.json + services/dbtunnel.service.js::openTunnelForDbEnv(). Khác cơ chế với
// jump-pod ở trên: thay vì 1 tiến trình socat lắng nghe port cố định trong pod do k8sctl tạo, ở
// đây mỗi kết nối cục bộ (mỗi lần UI mở query) mở 1 phiên `kubectl exec` riêng chạy 1 lệnh relay
// TCP ngắn hạn BÊN TRONG pod có sẵn — không đụng tiến trình chính (PID 1/container 1) của pod đó.

const RELAY_PROBE_TIMEOUT_MS = 10000;

class BufferWritable extends Writable {
  constructor() {
    super();
    this.chunks = [];
  }
  _write(chunk, _enc, cb) {
    this.chunks.push(chunk);
    cb();
  }
  text() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

async function loadK8sExec(kc) {
  const k8s = await import("@kubernetes/client-node").then((moduleValue) => moduleValue.default || moduleValue);
  return new k8s.Exec(kc);
}

// resolveContainerName — mặc định lấy container ĐẦU TIÊN trong spec pod, giống hành vi
// `kubectl exec` khi không truyền `-c` — không có UI nào cho chọn container riêng (out of scope,
// đa số pod ứng dụng chỉ có 1 container).
async function resolveContainerName({ coreV1, namespace, podName }) {
  const pod = await coreV1.readNamespacedPod({ name: podName, namespace });
  const containerName = pod?.spec?.containers?.[0]?.name;
  if (!containerName) {
    throw new AppError(`Không tìm thấy container nào trong pod "${podName}".`, 404, { podName });
  }
  return containerName;
}

// runExecCommand — chạy 1 lệnh, đợi tới khi tiến trình exec đó KẾT THÚC (không phải khi kết nối
// websocket mở xong — exec() của @kubernetes/client-node resolve ngay khi mở kết nối, kết quả
// thật (exit code) chỉ biết được qua statusCallback khi channel lỗi của giao thức exec báo về).
// Dùng cho probe (lệnh ngắn, tự thoát) — KHÔNG dùng cho relay chính (chạy tới khi socket đóng).
async function runExecCommand(execClient, { namespace, podName, containerName, command }) {
  const stdout = new BufferWritable();
  const stderr = new BufferWritable();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new AppError(`Lệnh probe trong pod "${podName}" quá thời gian chờ.`, 504, { podName }));
    }, RELAY_PROBE_TIMEOUT_MS);

    execClient
      .exec(namespace, podName, containerName, command, stdout, stderr, null, false, (status) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status, stdout: stdout.text(), stderr: stderr.text() });
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
}

// probeRelayCommand — dò lần lượt socat → nc → bash "/dev/tcp", trả về tool đầu tiên tồn tại. Gọi
// 1 LẦN/tunnel (không dò lại mỗi kết nối cục bộ) — caller (openTunnelViaExec) tự cache kết quả cho
// vòng đời tunnel đó. LƯU Ý: "/dev/tcp" là builtin của BASH, không phải POSIX sh — nhiều base image
// (Debian/Ubuntu) trỏ "/bin/sh" sang "dash", KHÔNG hỗ trợ "/dev/tcp" dù có "sh" — nên probe/relay
// fallback này phải đòi đúng "bash" tồn tại, không dùng "sh".
async function probeRelayCommand({ execClient, namespace, podName, containerName }) {
  const probeCommand = ["sh", "-c", "command -v socat || command -v nc || command -v bash || echo __none__"];
  const { stdout } = await runExecCommand(execClient, { namespace, podName, containerName, command: probeCommand });
  const text = stdout.trim();
  if (text.includes("socat")) return "socat";
  if (text.includes("nc")) return "nc";
  if (text.includes("bash")) return "bash";
  throw new AppError(
    `Không tìm thấy công cụ relay TCP (socat/nc/bash) bên trong pod "${podName}" — chọn 1 pod khác có sẵn 1 trong 3 công cụ này, hoặc bỏ trống "Pod có sẵn" trong Cấu hình để dùng chế độ jump pod mặc định.`,
    400,
    { podName }
  );
}

function buildRelayCommand(tool, dbHost, dbPort) {
  switch (tool) {
    case "socat":
      return ["socat", "-", `TCP:${dbHost}:${dbPort}`];
    case "nc":
      return ["nc", dbHost, String(dbPort)];
    case "bash":
      return ["bash", "-c", `exec 3<>/dev/tcp/${dbHost}/${dbPort}; cat <&3 & cat >&3; wait`];
    default:
      throw new AppError(`Relay tool không hợp lệ: ${tool}`, 500);
  }
}

// openExecRelayConnection — dùng cho 1 kết nối cục bộ (1 socket accept ở net.Server bên dưới).
// Truyền THẲNG socket đó làm cả stdout (dữ liệu từ DB trả về) lẫn stdin (query gửi đi) của phiên
// exec — tương đương cách openPortForward() truyền socket vào forward.portForward() ở trên, chỉ
// khác cơ chế vận chuyển (exec thay vì port-forward). stderr dùng stream riêng bỏ đi — không được
// lẫn vào cùng stream với dữ liệu giao thức DB (sẽ làm hỏng cả phiên).
function openExecRelayConnection({ execClient, namespace, podName, containerName, relayCommand, socket }) {
  const stderrSink = new BufferWritable();
  execClient
    .exec(namespace, podName, containerName, relayCommand, socket, stderrSink, socket, false, (status) => {
      const stderrText = stderrSink.text().trim();
      console.log(
        `[db-tunnel exec-relay] pod=${podName} status=${status?.status || "unknown"}` +
          (stderrText ? ` stderr=${JSON.stringify(stderrText)}` : "")
      );
      if (status?.status === "Failure" && !socket.destroyed) {
        socket.destroy(new Error(status.message || stderrText || `Relay trong pod "${podName}" kết thúc lỗi.`));
      } else if (!socket.destroyed) {
        socket.end();
      }
    })
    .then(() => {
      console.log(`[db-tunnel exec-relay] pod=${podName} websocket exec connected, relayCommand=${JSON.stringify(relayCommand)}`);
    })
    .catch((error) => {
      console.log(`[db-tunnel exec-relay] pod=${podName} exec() rejected: ${error?.message || error}`);
      if (!socket.destroyed) {
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
}

async function openExecPortForward({ execClient, namespace, podName, containerName, relayCommand }) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      openExecRelayConnection({ execClient, namespace, podName, containerName, relayCommand, socket });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// openTunnelViaExec — nhánh dbEnv.existingPodName: KHÔNG tạo/xoá pod nào, chỉ exec vào pod có sẵn.
// coreV1/kc: giống openTunnel() ở trên, provider caller (kubeconfig/rancher) tự dựng sẵn.
async function openTunnelViaExec({ coreV1, kc, namespace, podName, dbHost, dbPort }) {
  if (!dbHost || !dbPort) {
    throw new AppError(`Environment chưa khai dbHost/dbPort để mở exec-relay tunnel qua pod "${podName}".`, 400);
  }
  const execClient = await loadK8sExec(kc);
  const containerName = await resolveContainerName({ coreV1, namespace, podName });
  const tool = await probeRelayCommand({ execClient, namespace, podName, containerName });
  const relayCommand = buildRelayCommand(tool, dbHost, dbPort);
  const server = await openExecPortForward({ execClient, namespace, podName, containerName, relayCommand });
  const localPort = server.address().port;
  return { podName, server, localPort, execMode: true, relayTool: tool };
}

module.exports = {
  jumpPodName,
  openTunnel,
  closeTunnelServer,
  deleteJumpPod,
  openTunnelViaExec
};
