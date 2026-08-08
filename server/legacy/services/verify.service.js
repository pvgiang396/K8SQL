const fs = require("fs/promises");
const crypto = require("crypto");
// Dùng fetch CỦA CHÍNH package "undici" (không phải fetch built-in Node.js) khi truyền dispatcher
// là 1 Agent tạo từ package này — xem comment trong services/rancher.client.js để biết lý do (bug
// thật đã gặp: trộn 2 bản undici khác major gây lỗi "invalid onRequestStart method").
const { fetch: undiciFetch, Agent } = require("undici");
const { AppError } = require("../utils/error");
const { readNamespacesConfig, domainUrl } = require("./kube.service");
const rancherClient = require("./rancher.client");

function normalizeDomain(domain) {
  return String(domain || "").trim().toLowerCase().replace(/\/+$/, "");
}

async function resolveInsecureTLS(domain) {
  const namespaceConfigs = await readNamespacesConfig();
  const target = normalizeDomain(domain);
  const cluster = namespaceConfigs.find(
    (item) => Array.isArray(item.domains) && item.domains.some((candidate) => normalizeDomain(domainUrl(candidate)) === target)
  );

  if (!cluster || cluster.provider !== "rancher" || !cluster.rancherCluster) {
    return false;
  }

  try {
    const rancherCtx = await rancherClient.resolveRancherCluster(cluster.rancherCluster);
    return rancherCtx.insecureTLS;
  } catch {
    return false;
  }
}

function findFirstDiffOffset(bufferA, bufferB) {
  const length = Math.min(bufferA.length, bufferB.length);
  for (let i = 0; i < length; i += 1) {
    if (bufferA[i] !== bufferB[i]) {
      return i;
    }
  }
  return bufferA.length === bufferB.length ? -1 : length;
}

async function verifyDeploy({ domain, remotePath, localFilePath }) {
  if (!domain || !remotePath || !localFilePath) {
    throw new AppError("Missing required field: domain, remotePath, localFilePath", 400);
  }

  const url = `${normalizeDomain(domain)}${remotePath.startsWith("/") ? "" : "/"}${remotePath}`;

  let remoteBuffer;
  try {
    const insecureTLS = await resolveInsecureTLS(domain);
    const fetchOptions = {};
    if (insecureTLS) {
      fetchOptions.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    }
    const response = await undiciFetch(url, fetchOptions);
    if (!response.ok) {
      throw new AppError(`Failed to fetch remote URL: ${url} (HTTP ${response.status})`, 502);
    }
    remoteBuffer = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(`Failed to fetch remote URL: ${url}`, 502, { reason: error.message });
  }

  let localBuffer;
  try {
    localBuffer = await fs.readFile(localFilePath);
  } catch (error) {
    throw new AppError(`Failed to read local file: ${localFilePath}`, 400, { reason: error.message });
  }

  const remoteHash = crypto.createHash("sha256").update(remoteBuffer).digest("hex");
  const localHash = crypto.createHash("sha256").update(localBuffer).digest("hex");
  const same = remoteHash === localHash;

  const result = {
    same,
    url,
    localFilePath,
    remoteSize: remoteBuffer.length,
    localSize: localBuffer.length,
    remoteHash,
    localHash
  };

  if (!same) {
    const offset = findFirstDiffOffset(remoteBuffer, localBuffer);
    const contextRadius = 100;
    const start = Math.max(0, offset - contextRadius);
    result.firstDiffOffset = offset;
    result.remoteContextAtDiff = remoteBuffer.slice(start, offset + contextRadius).toString("utf8");
    result.localContextAtDiff = localBuffer.slice(start, offset + contextRadius).toString("utf8");
  }

  return result;
}

module.exports = {
  verifyDeploy
};
