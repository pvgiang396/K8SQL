"use strict";

const { createKubeContextByDomain, getGroupEntryByDomain, buildRancherContext, normalizeDomain } = require("./kube.service");
const { logOperation } = require("../utils/logger");
const { AppError } = require("../utils/error");
const kubeconfigDbTunnel = require("./providers/kubeconfig/dbtunnel");
const rancherDbTunnel = require("./providers/rancher/dbtunnel");
const permissionsService = require("./permissions.service");

// Không dùng jump pod/tunnel quá 15 phút không có query nào chạy qua nó — tránh rác Pod trong
// namespace. K8SQL gọi lại /db-tunnel/open trước mỗi query nên tunnel đang dùng thật sự không bao
// giờ chạm ngưỡng này.
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

// domain (normalized) -> { server, localPort, ctx, podName, lastUsedAt }
const tunnels = new Map();
// Cùng key với `tunnels` — Promise của lần mở tunnel ĐANG CHẠY cho key đó. Bắt buộc phải có vì
// giữa lúc kiểm tra "đã có tunnel chưa" và lúc thật sự ghi vào `tunnels` có 1 chuỗi `await` dài (dò
// quyền + tạo jump pod) — 2 request gần như đồng thời cho CÙNG 1 key (vd UI gọi list-schemas +
// autocomplete-schema cùng lúc) đều thấy `tunnels` trống, cùng đua tạo pod trùng tên → 1 cái được
// 201, cái kia bị 409 "already exists", rồi catch của request thua còn tự xoá pod best-effort —
// xoá NHẦM pod mà request thắng vừa tạo (bug thật đã gặp). withDedupedOpen() đảm bảo chỉ 1 lần mở
// tunnel thật sự chạy cho mỗi key, các lệnh gọi đến sau trong lúc đang mở chỉ await chung 1 Promise.
const pendingOpens = new Map();

function implFor(ctx) {
  return ctx.provider === "rancher" ? rancherDbTunnel : kubeconfigDbTunnel;
}

async function teardown(entry) {
  const impl = implFor(entry.ctx);
  await impl.closeTunnelServer(entry.server);
  // execMode (dbEnv.existingPodName): pod không do k8sctl tạo — không được xoá, chỉ đóng
  // net.Server (đóng socket → đóng phiên exec → tiến trình relay trong pod tự thoát).
  if (!entry.execMode) {
    await impl.deleteJumpPod(entry.ctx);
  }
}

// `buildEntry()` trả về { server, localPort, ctx, podName } khi mở tunnel thành công — hàm này lo
// phần cache/dedup chung, buildEntry() chỉ lo phần mở tunnel thật sự (khác nhau giữa openTunnel()/
// openTunnelForDbEnv()).
async function withDedupedOpen(key, buildEntry) {
  const existing = tunnels.get(key);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return { localPort: existing.localPort, expiresInSec: IDLE_TIMEOUT_MS / 1000 };
  }

  const pending = pendingOpens.get(key);
  if (pending) {
    return pending;
  }

  const openPromise = (async () => {
    const entry = await buildEntry();
    tunnels.set(key, { ...entry, lastUsedAt: Date.now() });
    return { localPort: entry.localPort, expiresInSec: IDLE_TIMEOUT_MS / 1000 };
  })();
  // Set NGAY (đồng bộ, trước await nào) để lệnh gọi kế tiếp — dù đến ngay sau — vẫn thấy pending và
  // await chung, không lọt qua khoảng hở race.
  pendingOpens.set(key, openPromise);
  try {
    return await openPromise;
  } finally {
    pendingOpens.delete(key);
  }
}

async function openTunnel(domain) {
  const key = normalizeDomain(domain);
  return withDedupedOpen(key, async () => {
    const ctx = await createKubeContextByDomain(domain);
    const group = await getGroupEntryByDomain(domain);

    // Dò quyền TRƯỚC khi thử tạo jump pod — tránh để lỗi 403 xảy ra giữa chừng lúc gọi
    // createNamespacedPod (khó phân biệt với lỗi khác), báo rõ ngay từ đầu nếu token chỉ có quyền
    // xem. Xem services/permissions.service.js.
    const access = await permissionsService.checkAccess(domain);
    if (!access.writeAccess) {
      const deniedChecks = Object.entries(access.checks)
        .filter(([, allowed]) => !allowed)
        .map(([k]) => k);
      throw new AppError(
        `Token chỉ có quyền xem (view-only) trong namespace "${access.namespace}" — không thể tạo jump pod để mở DB Tunnel. Thiếu quyền: ${deniedChecks.join(", ")}.`,
        403,
        { namespace: access.namespace, checks: access.checks }
      );
    }

    try {
      const { podName, server, localPort } = await implFor(ctx).openTunnel(ctx, {
        dbHost: group.db?.host,
        dbPort: group.db?.port,
        avoidNodeHostnames: group.db?.avoidNodeHostnames,
        requireNodeHostnames: group.db?.requireNodeHostnames
      });
      logOperation({ ...ctx, resource: "db-tunnel", operation: "open", success: true });
      return { server, localPort, ctx, podName };
    } catch (error) {
      // Jump pod có thể đã được tạo (vd timeout chờ Running) trước khi lỗi ném ra — dọn best-effort
      // để không để rác Pod trong namespace thật khi openTunnel() thất bại giữa chừng. An toàn với
      // race vì withDedupedOpen() đảm bảo chỉ 1 lần mở đang chạy cho key này.
      try {
        await implFor(ctx).deleteJumpPod(ctx);
      } catch {
        // ignore — ưu tiên trả lỗi gốc, dọn dẹp chỉ là best-effort
      }
      logOperation({ ...ctx, resource: "db-tunnel", operation: "open", success: false, error: error.message });
      throw error;
    }
  });
}

// openTunnelForDbEnv — nhánh "tự đủ" cho db-environments.json entry có field rancherKey (không
// cần entry khớp trong namespaces.json, khác openTunnel(domain) ở trên). Chỉ hỗ trợ provider
// Rancher (đúng field rancherKey/projectId khai trong db-environments.json) — provider kubeconfig
// tự đủ để dành task riêng sau nếu cần. Key cache trong CÙNG Map `tunnels` là dbEnv.name — không
// đụng nhánh domain-based vì domain thật (chuỗi có scheme/host) và tên environment là 2 không gian
// giá trị khác nhau, không thể trùng.
async function openTunnelForDbEnv(dbEnv) {
  const key = `db-env:${dbEnv.name}`;
  return withDedupedOpen(key, async () => {
    const domainLabel = `db-env:${dbEnv.name}`;
    const ctx = await buildRancherContext({
      domain: domainLabel,
      clusterName: dbEnv.rancherKey,
      rancherCluster: dbEnv.rancherKey,
      namespace: dbEnv.namespace,
      projectId: dbEnv.projectId
    });

    // existingPodName: dùng pod có sẵn qua exec-relay, KHÔNG tạo/xoá pod — nhánh quyền + mở tunnel
    // hoàn toàn khác nhánh jump-pod mặc định bên dưới. Xem services/providers/dbtunnel-core.js.
    if (dbEnv.existingPodName) {
      const access = await permissionsService.checkAccessForCtx(ctx, permissionsService.EXEC_TUNNEL_CHECKS);
      if (!access.writeAccess) {
        throw new AppError(
          `Token không có quyền "exec" vào pod "${dbEnv.existingPodName}" trong namespace "${access.namespace}" — không thể mở DB Tunnel qua pod có sẵn. Thiếu quyền: pods/exec (create).`,
          403,
          { namespace: access.namespace, checks: access.checks, podName: dbEnv.existingPodName }
        );
      }

      try {
        const { podName, server, localPort, relayTool } = await rancherDbTunnel.openTunnelViaExec(ctx, {
          podName: dbEnv.existingPodName,
          dbHost: dbEnv.dbHost,
          dbPort: dbEnv.dbPort
        });
        logOperation({ ...ctx, resource: "db-tunnel", operation: "open-exec", success: true, relayTool });
        return { server, localPort, ctx, podName, execMode: true };
      } catch (error) {
        logOperation({ ...ctx, resource: "db-tunnel", operation: "open-exec", success: false, error: error.message });
        throw error;
      }
    }

    const access = await permissionsService.checkAccessForCtx(ctx);
    if (!access.writeAccess) {
      const deniedChecks = Object.entries(access.checks)
        .filter(([, allowed]) => !allowed)
        .map(([k]) => k);
      throw new AppError(
        `Token chỉ có quyền xem (view-only) trong namespace "${access.namespace}" — không thể tạo jump pod để mở DB Tunnel. Thiếu quyền: ${deniedChecks.join(", ")}.`,
        403,
        { namespace: access.namespace, checks: access.checks }
      );
    }

    try {
      const { podName, server, localPort } = await rancherDbTunnel.openTunnel(ctx, {
        dbHost: dbEnv.dbHost,
        dbPort: dbEnv.dbPort,
        avoidNodeHostnames: dbEnv.avoidNodeHostnames,
        requireNodeHostnames: dbEnv.requireNodeHostnames
      });
      logOperation({ ...ctx, resource: "db-tunnel", operation: "open", success: true });
      return { server, localPort, ctx, podName };
    } catch (error) {
      try {
        await rancherDbTunnel.deleteJumpPod(ctx);
      } catch {
        // ignore — ưu tiên trả lỗi gốc, dọn dẹp chỉ là best-effort
      }
      logOperation({ ...ctx, resource: "db-tunnel", operation: "open", success: false, error: error.message });
      throw error;
    }
  });
}

async function closeTunnel(domain) {
  const key = normalizeDomain(domain);
  const entry = tunnels.get(key);
  if (!entry) {
    return { message: "Không có tunnel đang mở cho domain này." };
  }
  tunnels.delete(key);

  try {
    await teardown(entry);
    logOperation({ ...entry.ctx, resource: "db-tunnel", operation: "close", success: true });
    return { message: `Tunnel đã đóng cho domain: ${domain}` };
  } catch (error) {
    logOperation({ ...entry.ctx, resource: "db-tunnel", operation: "close", success: false, error: error.message });
    throw error;
  }
}

// closeTunnelForDbEnv — đối xứng closeTunnel() nhưng cho key `db-env:<name>` (openTunnelForDbEnv),
// KHÔNG qua normalizeDomain() vì key đó không phải domain (giữ nguyên hoa/thường của dbEnv.name).
async function closeTunnelForDbEnv(name) {
  const key = `db-env:${name}`;
  const entry = tunnels.get(key);
  if (!entry) {
    return { message: "Không có tunnel đang mở cho environment này." };
  }
  tunnels.delete(key);

  try {
    await teardown(entry);
    logOperation({ ...entry.ctx, resource: "db-tunnel", operation: "close", success: true });
    return { message: `Tunnel đã đóng cho environment: ${name}` };
  } catch (error) {
    logOperation({ ...entry.ctx, resource: "db-tunnel", operation: "close", success: false, error: error.message });
    throw error;
  }
}

async function cleanupIdleTunnels() {
  const now = Date.now();
  for (const [key, entry] of tunnels) {
    if (now - entry.lastUsedAt <= IDLE_TIMEOUT_MS) {
      continue;
    }
    tunnels.delete(key);
    try {
      await teardown(entry);
      logOperation({ ...entry.ctx, resource: "db-tunnel", operation: "idle-cleanup", success: true });
    } catch (error) {
      logOperation({ ...entry.ctx, resource: "db-tunnel", operation: "idle-cleanup", success: false, error: error.message });
    }
  }
}

let cleanupTimer;
function startIdleCleanup() {
  if (cleanupTimer) {
    return;
  }
  cleanupTimer = setInterval(() => {
    cleanupIdleTunnels().catch(() => {});
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();
}

startIdleCleanup();

module.exports = { openTunnel, openTunnelForDbEnv, closeTunnel, closeTunnelForDbEnv };
