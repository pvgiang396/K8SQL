// Client gọi native_bridge.rs (HTTP loopback do Rust sở hữu) để đọc/ghi secret qua OS keychain —
// sidecar Node KHÔNG tự truy cập OS keychain trực tiếp (không có binding phù hợp cho SEA, và giữ
// đúng thiết kế "Rust sở hữu keychain" đã chốt trong plan).

function readArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

const BRIDGE_URL = readArg("native-bridge-url");
const BRIDGE_TOKEN = readArg("native-bridge-token");

function ensureConfigured(): { url: string; token: string } {
  if (!BRIDGE_URL || !BRIDGE_TOKEN) {
    throw new Error(
      "native bridge chưa được cấu hình (thiếu --native-bridge-url/--native-bridge-token) — " +
        "sidecar phải được Tauri spawn (spawn_dev/spawn_release), không chạy độc lập khi cần secret."
    );
  }
  return { url: BRIDGE_URL, token: BRIDGE_TOKEN };
}

async function getSecret(ref: string): Promise<string | undefined> {
  const { url, token } = ensureConfigured();
  const res = await fetch(`${url}/secret/${encodeURIComponent(ref)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`keychainClient.getSecret(${ref}) thất bại: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { value: string | null };
  return body.value ?? undefined;
}

async function setSecret(ref: string, value: string): Promise<void> {
  const { url, token } = ensureConfigured();
  const res = await fetch(`${url}/secret/${encodeURIComponent(ref)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) {
    throw new Error(`keychainClient.setSecret(${ref}) thất bại: HTTP ${res.status}`);
  }
}

async function deleteSecret(ref: string): Promise<void> {
  const { url, token } = ensureConfigured();
  const res = await fetch(`${url}/secret/${encodeURIComponent(ref)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`keychainClient.deleteSecret(${ref}) thất bại: HTTP ${res.status}`);
  }
}

async function getAutostart(): Promise<boolean> {
  const { url, token } = ensureConfigured();
  const res = await fetch(`${url}/autostart`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`getAutostart thất bại: HTTP ${res.status}`);
  const body = (await res.json()) as { enabled: boolean };
  return body.enabled;
}

async function setAutostart(enabled: boolean): Promise<boolean> {
  const { url, token } = ensureConfigured();
  const res = await fetch(`${url}/autostart`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error(`setAutostart thất bại: HTTP ${res.status}`);
  const body = (await res.json()) as { enabled: boolean };
  return body.enabled;
}

function isConfigured(): boolean {
  return Boolean(BRIDGE_URL && BRIDGE_TOKEN);
}

module.exports = { getSecret, setSecret, deleteSecret, getAutostart, setAutostart, isConfigured };
