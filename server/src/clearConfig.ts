// Nút "Làm sạch cấu hình" (🧨, public/index.html) — xoá SẠCH toàn bộ Rancher cluster/Connection
// String/Nhóm namespace đã lưu, kể cả secret trong keychain. Dùng khi user muốn reset về trạng thái
// sạch (vd để test lại import config từ đầu, không nghi ngờ dữ liệu cũ còn sót — xem
// k8sql/CLAUDE.md). Tận dụng cơ chế "replace-all theo diff" đã có sẵn trong settingsRepo.ts
// (gọi upsertX([]) tự xoá toàn bộ row hiện có + best-effort xoá secret keychain cho từng row biến
// mất) thay vì tự viết lại logic enumerate+xoá secret.

const { getDb } = require("./config/db.ts");
const { refreshProcessEnvSecrets } = require("./secrets/envShim.ts");
const keychainClient = require("./secrets/keychainClient.ts");
const settingsRepo = require("./config/repository/settingsRepo.ts");

interface ClearAllConfigResult {
  dbEnvironmentsCleared: number;
  rancherClustersCleared: number;
  namespaceGroupsCleared: number;
}

async function clearAllConfig(): Promise<ClearAllConfigResult> {
  const db = getDb();
  const dbEnvironmentsCleared = (db.prepare("SELECT COUNT(*) c FROM db_environments").get() as { c: number }).c;
  const rancherClustersCleared = (db.prepare("SELECT COUNT(*) c FROM rancher_clusters").get() as { c: number }).c;
  const groupRows = db.prepare("SELECT id, kubeconfig_secret_ref FROM namespace_groups").all() as
    { id: number; kubeconfig_secret_ref: string | null }[];

  // Xoá db_environments VÀ namespace_groups TRƯỚC rancher_clusters — cả 2 bảng đều có FK
  // rancher_cluster_id trỏ vào rancher_clusters (SQLite ở đây CÓ enforce FK — xác nhận thật bằng
  // test: xoá clusters trước khi group tham chiếu còn tồn tại ném "FOREIGN KEY constraint failed").
  // db_environments/namespace_groups không phụ thuộc lẫn nhau nên thứ tự giữa 2 cái không quan trọng.
  await settingsRepo.upsertDbEnvironments([]);

  // kubeconfig_secret_ref: cột tồn tại trong schema nhưng hiện chưa có code path nào ghi giá trị
  // (luôn NULL trong thực tế) — vẫn xoá phòng hờ cho tương lai, không giả định luôn rỗng.
  // upsertNamespaceGroups([]) KHÔNG tự xoá secret này (chỉ rancher/db-env upsert mới làm), nên xoá
  // tay ở đây trước khi xoá row.
  for (const g of groupRows) {
    if (g.kubeconfig_secret_ref) {
      await keychainClient.deleteSecret(g.kubeconfig_secret_ref).catch(() => {});
    }
  }
  await settingsRepo.upsertNamespaceGroups([]);

  await settingsRepo.upsertRancherClusters([]);

  // migration_log không có helper riêng trong settingsRepo — xoá thẳng, đây chỉ là log lịch sử.
  db.prepare("DELETE FROM migration_log").run();

  // KHÔNG đụng app_settings (chỉ có schemaVersion) — không phải "cấu hình kết nối" user khai báo.

  await refreshProcessEnvSecrets();

  return { dbEnvironmentsCleared, rancherClustersCleared, namespaceGroupsCleared: groupRows.length };
}

module.exports = { clearAllConfig };
