// URL KEY = công thức cũ + tên database từ path của connection string.
// Không đưa query parameter (Mongo authSource có thể khác database cần truy vấn) vào key.
function deriveDbEnvKey(oldName: string, connectionString: string): string {
  const match = String(connectionString || "").match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*\/([^?#]*)/i);
  if (!match?.[1]) return oldName;
  let database = match[1];
  try {
    database = decodeURIComponent(database);
  } catch {
    // Giữ nguyên nếu URL chứa escape không hợp lệ.
  }
  const suffix = database.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return suffix && !oldName.endsWith(`_${suffix}`) ? `${oldName}_${suffix}` : oldName;
}

module.exports = { deriveDbEnvKey };
