// Công thức Rancher Key (rancher_clusters.name) — dùng chung UI Settings (bản JS song song trong
// public/shared/settings-modal.js, phải giữ đúng 1 công thức) và migration dữ liệu đã lưu.
//
// ID = <key sinh từ Rancher URL>_<suffix>. Suffix ưu tiên Rancher username (nếu có), không thì
// phần token trước dấu ':'. Cùng 1 URL có thể gắn nhiều token/user khác quyền.

function deriveKeyFromUrl(text: string): string {
  return String(text || "")
    .replace(/^https?:\/\//i, "")
    .replace(/\./g, "_")
    .toUpperCase();
}

function tokenIdPrefix(token: string | undefined | null): string {
  const raw = String(token || "").trim();
  const colon = raw.indexOf(":");
  if (colon <= 0) return "";
  return raw.slice(0, colon);
}

function rancherKeySuffix(token?: string | null, username?: string | null): string {
  const user = String(username || "").trim();
  if (user) return user;
  return tokenIdPrefix(token);
}

function deriveRancherKey(rancherUrl: string, token?: string | null, username?: string | null): string {
  const base = deriveKeyFromUrl(rancherUrl);
  const suffix = rancherKeySuffix(token, username);
  if (!base) return "";
  if (!suffix) return base;
  return `${base}_${suffix}`;
}

module.exports = { deriveKeyFromUrl, tokenIdPrefix, rancherKeySuffix, deriveRancherKey };
