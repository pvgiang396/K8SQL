// Component dùng chung cho popup quickstart (scripts/wizard.html) VÀ popup ⚙️ "Cấu hình" live
// (public/index.html) — trước đây 2 nơi copy tay gần như y hệt markup/CSS/JS, nay chỉ 1 bản duy
// nhất, tham số hoá qua endpoints + applyLabel. Không dùng build step (khớp triết lý "không build
// step" của cả k8sctl) — file này load thẳng bằng <script type="module">.

// Placeholder dạng dấu chấm tròn — hiện khi field ĐÃ có giá trị lưu sẵn trên server (hasValue) để
// trông giống 1 password đã điền, thay vì câu giải thích dài dòng (chuyển câu đó sang title/tooltip).
const MASKED_PLACEHOLDER = "●".repeat(16); // ●●●●●●●●●●●●●●●●

// Sentinel value cho option "nhập tay" chèn cuối <select> ở buildCascadeCell() — cho phép override
// thủ công ngay cả khi API đã trả về danh sách hợp lệ (vd resource có thật trên cluster nhưng chưa
// gán vào Rancher Project đang chọn nên không lọt vào danh sách cascade của project đó).
const MANUAL_OVERRIDE_SENTINEL = "__manual_override__";

function slugEnvVar(name, suffix) {
  const base = String(name || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${base}${suffix}`;
}

// Công thức mota.md: xóa https://, http://, thay "." thành "_", viết hoa toàn bộ.
function deriveKeyFromUrl(text) {
  return String(text || "")
    .replace(/^https?:\/\//i, "")
    .replace(/\./g, "_")
    .toUpperCase();
}

// Cho phép nhiều Rancher cluster cùng domain (khác token) — trước đây bị chặn vì Rancher Key sinh
// thuần từ domain gây trùng. Entry đầu tiên của 1 domain giữ key trần (không phá key cũ đã lưu/đang
// tham chiếu ở db-environments.json), entry thứ 2/3.. cùng domain cộng thêm _<số thứ tự>.
function deriveUniqueRancherKey(cluster, clusters) {
  const base = deriveKeyFromUrl(cluster.rancherUrl);
  if (!base) return base;
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:_(\\d+))?$`);
  let baseTaken = false;
  let maxSeq = 1;
  clusters.forEach((c) => {
    if (c === cluster) return;
    const m = pattern.exec(c.name || "");
    if (!m) return;
    if (m[1]) maxSeq = Math.max(maxSeq, Number(m[1]));
    else baseTaken = true;
  });
  return baseTaken ? `${base}_${maxSeq + 1}` : base;
}

// Phân tích host:port THẬT từ Connection String (nếu có) để tự điền cột "DB Host/Port" — chỉ khớp
// khi chuỗi chứa host:port tường minh (kết nối trực tiếp). Chuỗi k8s-tunnel dùng placeholder
// "__HOST__" (xem services/providers/postgres/query.js::resolveConnectionString()) không có port
// đi kèm nên KHÔNG khớp — đúng ý: lúc đó DB Host/Port phải gõ tay vì mới là đích thật của tunnel,
// không nằm trong Connection String.
function parseHostPortFromConnectionString(text) {
  const m = String(text || "").match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:?]+):(\d+)/i);
  return m ? { host: m[1], port: m[2] } : null;
}

// toTunnelConnectionTemplate — entry mode k8s-tunnel (có rancherKey) BẮT BUỘC connection string
// phải chứa placeholder "__HOST__" thay vì host:port thật (xem resolveConnectionString()), nhưng
// user tự nhiên sẽ paste nguyên connection string thật (vd copy từ psql/pgAdmin) vì UI trước đây
// không có gợi ý nào — bug thật đã gặp: k8sctl vẫn LƯU được (không validate), rồi connect thẳng từ
// máy chạy k8sctl tới host thật thay vì qua tunnel, timeout vô lý không liên quan gì tunnel/pod.
// Tự thay host:port thật (nếu có) bằng "__HOST__" ngay lúc lưu — user không cần biết quy ước này.
function toTunnelConnectionTemplate(urlValue) {
  const parsed = parseHostPortFromConnectionString(urlValue);
  if (!parsed) return urlValue;
  return urlValue.replace(`${parsed.host}:${parsed.port}`, "__HOST__");
}

// dbType lấy từ scheme connection string (vd mongodb, postgresql) — hoạt động cả với chuỗi có
// placeholder __HOST__ (mode k8s-tunnel) vì scheme luôn còn nguyên trước placeholder, xem CLAUDE.md.
function parseDbTypeFromConnectionString(text) {
  const m = String(text || "").match(/^([a-z][a-z0-9+.-]*):\/\//i);
  return m ? m[1].toLowerCase() : "";
}

// createField — 1 hàng "label + value" trong card danh sách (Rancher/Connection String), thay cho
// <td> của bảng cũ. Trả về {field, value} — `field` để appendChild vào card, `value` là container
// nhận nội dung thật (input/select/nút...), đúng vai trò `cell` cũ (row.children[N]).
function createField(label) {
  const field = document.createElement("div");
  field.className = "sm-field";
  const labelEl = document.createElement("span");
  labelEl.className = "sm-field-label";
  labelEl.textContent = label;
  const value = document.createElement("span");
  value.className = "sm-field-value";
  field.appendChild(labelEl);
  field.appendChild(value);
  return { field, value };
}

// attachPasswordToggle — bọc 1 input password vào wrapper button-group (cùng công thức
// `.sm-input-group`/`#smBtnBrowseDir` ở thư mục cài đặt: input bo góc trái, button bo góc phải,
// border liền không double ở giữa) rồi chèn nút icon con mắt để chuyển qua lại type="password"/
// "text". Trả về wrapper element — gọi code chèn wrapper này vào cell thay vì chèn input trực
// tiếp. Không đụng logic value/event đã gắn sẵn lên input (input được truyền vào đã có đủ
// value/placeholder/listener, hàm này chỉ thêm UI hiện/ẩn).
//
// `onReveal` — callback async optional `() => Promise<string>` trả về giá trị THẬT đã lưu (đọc từ
// .env qua API reveal-token/reveal-value, xem endpoints.revealRancherToken/revealDbEnvironmentValue
// ở renderRancherTable()/renderDbEnvTable()). Server KHÔNG BAO GIỜ trả secret thật qua các API
// list*() thông thường (chỉ hasValue) nên nếu không có onReveal, bấm con mắt chỉ toggle hiển thị
// GIÁ TRỊ VỪA GÕ trong phiên này (input rỗng vẫn rỗng) — đúng hành vi cũ. Có onReveal + input đang
// rỗng (chưa gõ gì phiên này) → gọi API lấy giá trị thật đúng 1 lần (cờ `revealed`), gán vào
// input.value rồi mới toggle sang text.
function attachPasswordToggle(input, onReveal) {
  const wrapper = document.createElement("div");
  wrapper.className = "sm-password-group";
  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "sm-toggle-visibility";
  toggleBtn.title = "Hiện/ẩn giá trị";
  toggleBtn.setAttribute("aria-label", "Hiện/ẩn giá trị");
  toggleBtn.textContent = "👁";
  let revealed = false;
  toggleBtn.addEventListener("click", async () => {
    const showing = input.type === "text";
    if (!showing && !revealed && !input.value && onReveal) {
      toggleBtn.disabled = true;
      const prevIcon = toggleBtn.textContent;
      toggleBtn.textContent = "⏳";
      try {
        input.value = (await onReveal()) || "";
        revealed = true;
        input.title = "";
      } catch (error) {
        input.title = `Lỗi lấy giá trị thật: ${error.message}`;
        toggleBtn.disabled = false;
        toggleBtn.textContent = prevIcon;
        return;
      }
      toggleBtn.disabled = false;
    }
    input.type = showing ? "password" : "text";
    toggleBtn.textContent = showing ? "👁" : "🙈";
  });
  wrapper.appendChild(input);
  wrapper.appendChild(toggleBtn);
  return wrapper;
}

// confirmDeleteWithKey — dialog xác nhận xoá bắt gõ lại đúng Key (Rancher Key/URL Key) trước khi
// cho xoá, mục đích chắc chắn không phải do bấm nhầm nút xoá. Không có sẵn component modal/dialog
// nào trong codebase (chỉ có window.confirm() native trước đây) nên viết mới tối giản, tự chứa —
// KHÔNG dùng chung .modal-overlay/.modal-box của public/index.html vì file này còn được dùng độc
// lập ở scripts/wizard.html (không có 2 class đó). Append thẳng vào document.body (không lồng vào
// mountEl) để tránh bị kẹt trong vùng scroll của .modal-box khi chạy trong popup Cấu hình.
function confirmDeleteWithKey({ keyLabel, expectedKey, itemLabel }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "sm-confirm-overlay";

    const box = document.createElement("div");
    box.className = "sm-confirm-box";

    const title = document.createElement("h4");
    title.textContent = "Xác nhận xoá";
    box.appendChild(title);

    const desc = document.createElement("p");
    const itemStrong = document.createElement("strong");
    itemStrong.textContent = itemLabel;
    const keyStrong = document.createElement("strong");
    keyStrong.textContent = keyLabel;
    const keyCode = document.createElement("code");
    keyCode.textContent = expectedKey;
    desc.append("Sắp xoá ", itemStrong, ". Nhập lại đúng ", keyStrong, " (", keyCode, ") để xác nhận:");
    box.appendChild(desc);

    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.placeholder = expectedKey;
    box.appendChild(input);

    const actions = document.createElement("div");
    actions.className = "sm-confirm-actions";
    const btnCancel = document.createElement("button");
    btnCancel.type = "button";
    btnCancel.className = "secondary";
    btnCancel.textContent = "Bỏ qua";
    const btnConfirm = document.createElement("button");
    btnConfirm.type = "button";
    btnConfirm.className = "sm-btn-danger";
    btnConfirm.textContent = "Xóa ngay";
    btnConfirm.disabled = true;
    actions.appendChild(btnCancel);
    actions.appendChild(btnConfirm);
    box.appendChild(actions);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    input.focus();

    function cleanup(result) {
      overlay.remove();
      resolve(result);
    }

    input.addEventListener("input", () => {
      btnConfirm.disabled = input.value !== expectedKey;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") cleanup(false);
      if (event.key === "Enter" && !btnConfirm.disabled) cleanup(true);
    });
    btnCancel.addEventListener("click", () => cleanup(false));
    btnConfirm.addEventListener("click", () => cleanup(true));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) cleanup(false);
    });
  });
}

// createDescHeader — hàng ĐẦU TIÊN của mỗi card (thay cho field "STT" + field "Mô tả" giữa + field
// "Thao tác" cuối trước đây): bên TRÁI là icon + "<labelPrefix> <index>:" + mô tả (text, bấm ✏️ để
// chuyển sang <input> sửa tại chỗ, Enter/blur commit, Escape huỷ — chỉ phần mô tả sửa được, không
// sửa icon/label/số thứ tự) + icon trạng thái (nếu có); bên PHẢI là cụm ✏️ + icon thao tác (xoá/
// kiểm tra kết nối) — đóng vai trò "header" của card nên luôn tô nền xám (`.sm-card-header`), không
// dùng lại `label/value` như field thường. `onCommit` chỉ cập nhật state cục bộ (giống input Mô tả
// cũ) — ghi xuống file thật khi bấm "Áp dụng". Trả về {header, actionsSlot, statusSlot} —
// actionsSlot đã có sẵn nút ✏️, caller `appendChild()` thêm icon thao tác khác vào SAU nó; statusSlot
// (chỉ tạo khi `withStatus: true`) nằm ngay sau text Mô tả (bên trái) — dùng cho icon kết quả
// "Kiểm tra kết nối" (Connection String, xem renderStatusCell()), thay cho field "Trạng thái" đứng
// riêng trước đây.
function createDescHeader({ index, getValue, onCommit, placeholder, withStatus, icon, iconAlt, labelPrefix }) {
  const header = document.createElement("div");
  header.className = "sm-card-header";

  const main = document.createElement("div");
  main.className = "sm-card-header-main";

  const iconEl = document.createElement("img");
  iconEl.className = "sm-card-icon";
  iconEl.src = icon;
  iconEl.alt = iconAlt || "";

  const indexEl = document.createElement("span");
  indexEl.className = "sm-card-index";
  indexEl.textContent = `${labelPrefix} ${index}:`;

  const textEl = document.createElement("span");
  textEl.className = "sm-card-desc-text";

  function renderText() {
    const value = getValue();
    if (value) {
      textEl.textContent = value;
      textEl.classList.remove("placeholder");
    } else {
      textEl.textContent = placeholder || "Mô tả (tuỳ chọn)";
      textEl.classList.add("placeholder");
    }
  }
  renderText();

  const editBtn = document.createElement("a");
  editBtn.href = "#";
  editBtn.className = "sm-btn-edit-desc";
  editBtn.title = "Sửa mô tả";
  editBtn.textContent = "✏️";

  function enterEditMode() {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "sm-card-desc-input";
    input.value = getValue() || "";
    const commit = () => {
      onCommit(input.value.trim());
      renderText();
      input.replaceWith(textEl);
      editBtn.style.display = "";
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        input.value = getValue() || "";
        input.blur();
      }
    });
    input.addEventListener("blur", commit, { once: true });
    textEl.replaceWith(input);
    editBtn.style.display = "none";
    input.focus();
    input.select();
  }

  editBtn.addEventListener("click", (e) => {
    e.preventDefault();
    enterEditMode();
  });

  main.appendChild(iconEl);
  main.appendChild(indexEl);
  main.appendChild(textEl);

  let statusSlot = null;
  if (withStatus) {
    statusSlot = document.createElement("span");
    statusSlot.className = "sm-card-status";
    main.appendChild(statusSlot);
  }

  // Bút chì canh về BÊN PHẢI của card (cùng cụm với icon xoá/kiểm tra kết nối) — không còn nằm
  // ngay sau text Mô tả như trước, đặt vào actionsSlot TRƯỚC khi caller appendChild icon thao tác
  // khác vào, để thứ tự DOM là [bút chì][kiểm tra kết nối?][xoá].
  const actionsSlot = document.createElement("div");
  actionsSlot.className = "sm-card-header-actions";
  actionsSlot.appendChild(editBtn);

  header.appendChild(main);
  header.appendChild(actionsSlot);

  return { header, actionsSlot, statusSlot };
}

const STATUS_ICON = {
  loading: { icon: "⏳", title: "Đang kiểm tra..." },
  fail: { icon: "❌", title: "Kiểm tra thất bại" },
  "success-write": { icon: "✅", title: "Kết nối thành công — được phép ghi" },
  "success-readonly": { icon: "\u{1F512}", title: "Kết nối thành công — chỉ đọc" }
};

// env._testStatus = { kind, message? } — set bởi testConnection(), undefined nếu chưa kiểm tra lần
// nào (kể cả entry vừa tải từ server, KHÔNG tự suy ra trạng thái từ allowWrite — phải bấm "Kiểm tra
// kết nối" thật mới biết connection có sống hay không).
function renderStatusCell(cell, env) {
  cell.innerHTML = "";
  const st = env._testStatus;
  const span = document.createElement("span");
  if (!st) {
    span.textContent = "—";
    span.title = "Chưa kiểm tra";
    span.style.opacity = "0.5";
  } else {
    const meta = STATUS_ICON[st.kind] || {};
    span.textContent = meta.icon || "?";
    span.title = st.message || meta.title || "";
  }
  cell.appendChild(span);
}

// URL KEY (định danh Connection String) tự sinh — giống tinh thần công thức Rancher Key: dùng
// namespace+dbHost khi có Rancher (k8s-tunnel), hoặc host rút ra từ chính connection string gõ
// tay khi không dùng Rancher. Cộng thêm tiền tố dbType (từ scheme connection string) + hậu tố port
// — để cùng 1 IP nhưng khác port/khác DB engine vẫn khai được 2 connection string khác nhau.
function deriveDbEnvKey(env) {
  let base;
  if (env.rancherKey && env.namespace && env.dbHost) {
    base = `${env.namespace}_${env.dbHost}`;
  } else {
    const m = String(env.urlValue || "").match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:?]+)/i);
    base = m ? m[1] : env.urlValue;
  }
  const dbType = parseDbTypeFromConnectionString(env.urlValue);
  const parts = [dbType, base, env.dbPort].filter(Boolean);
  return parts
    .join("_")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export async function initSettingsModal({ mountEl, endpoints, applyLabel, onClose, onApplied }) {
  mountEl.innerHTML = await fetch(endpoints.fragment || "/shared/settings-modal.html").then((r) => r.text());

  const $ = (id) => mountEl.querySelector(`#${id}`);
  const autostartToggle = $("smAutostartToggle");
  const rancherBody = $("smRancherTableBody");
  const dbEnvBody = $("smDbEnvTableBody");
  const btnAddCluster = $("smBtnAddCluster");
  const btnAddDbEnv = $("smBtnAddDbEnv");
  const statusEl = $("smStatus");
  const btnClose = $("smBtnClose");
  const btnApply = $("smBtnApply");

  if (applyLabel) {
    btnApply.textContent = applyLabel;
  }

  const state = { rancherClusters: [], dbEnvironments: [] };

  // resolveRancherTarget — quy về 1 trong 2 dạng payload gửi cho các endpoint "*-adhoc"/"*-for-db-env":
  // {rancherKey} nếu cluster env.rancherKey trỏ tới ĐÃ "Áp dụng" (đọc token qua .env ở server), hoặc
  // {rancherUrl, token, clusterId, insecureTLS} nếu cluster đó còn "isNew" (dùng thẳng dữ liệu đang gõ
  // trên UI, chưa lưu) — cùng tinh thần useAdhoc ở fetchCascade(). null nếu chưa chọn Rancher nào (env
  // không dùng k8s-tunnel — DB Host/Port là host thật kết nối trực tiếp). {incomplete:true} nếu đã
  // chọn 1 cluster isNew nhưng chưa gõ đủ URL/Token/Cluster ID để dò ad-hoc.
  function resolveRancherTarget(env) {
    if (!env.rancherKey) return null;
    const cluster = state.rancherClusters.find((c) => c.name === env.rancherKey);
    if (!cluster) return null;
    if (cluster.isNew) {
      if (!cluster.rancherUrl || !cluster.tokenValue || !cluster.clusterId) return { incomplete: true };
      return { rancherUrl: cluster.rancherUrl, token: cluster.tokenValue, clusterId: cluster.clusterId, insecureTLS: true };
    }
    return { rancherKey: cluster.name };
  }

  // Namespace/Project/Rancher đổi → danh sách "Pod có sẵn" cũ (nếu đã tải) không còn đúng ngữ cảnh,
  // và pod đã chọn trước đó (nếu có) có thể không còn tồn tại trong namespace/project mới.
  function resetPodsCache(env) {
    env._pods = null;
    env.existingPodName = undefined;
  }

  function setStatus(message, kind) {
    statusEl.textContent = message || "";
    statusEl.className = `sm-status${kind ? ` ${kind}` : ""}`;
  }

  // Dò cluster THẬT bằng Rancher URL+Token user vừa gõ (chưa "Áp dụng", chưa có trong .env) — gợi ý
  // clusterId qua combobox. Chỉ gọi được khi cả 2 field không rỗng (trigger ở renderRancherTable()
  // qua sự kiện blur, không debounce theo từng keystroke).
  async function fetchClusterOptions(cluster) {
    cluster._clusterOptions = "loading";
    renderRancherTable();
    try {
      const body = await fetch(endpoints.rancherClusterOptions, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rancherUrl: cluster.rancherUrl,
          token: cluster.tokenValue,
          insecureTLS: true
        })
      }).then((r) => r.json());
      if (body.success === false) throw new Error(body.message || "Không tải được danh sách.");
      cluster._clusterOptions = (body.data || []).map((c) => ({ value: c.id, label: c.name }));
    } catch (error) {
      cluster._clusterOptions = { error: true, message: error.message || "Không tải được." };
    }
    renderRancherTable();
  }

  function renderRancherTable() {
    rancherBody.innerHTML = "";
    state.rancherClusters.forEach((cluster, index) => {
      const row = document.createElement("div");
      row.className = "sm-card";

      const descHeader = createDescHeader({
        index: index + 1,
        getValue: () => cluster.description,
        onCommit: (value) => {
          cluster.description = value;
        },
        placeholder: "Mô tả (tuỳ chọn)",
        icon: "/assets/k8s.png",
        iconAlt: "Rancher",
        labelPrefix: "Rancher"
      });
      row.appendChild(descHeader.header);
      const actionsCell = descHeader.actionsSlot;

      const urlField = createField("Rancher URL");
      row.appendChild(urlField.field);
      const urlCell = urlField.value;

      const tokenField = createField("Rancher token");
      row.appendChild(tokenField.field);
      const tokenCell = tokenField.value;

      const clusterIdField = createField("Cluster ID");
      row.appendChild(clusterIdField.field);
      const clusterIdCell = clusterIdField.value;

      const keyField = createField("Rancher Key");
      row.appendChild(keyField.field);
      const keyCell = keyField.value;

      const maybeFetchClusterOptions = () => {
        if (cluster.rancherUrl && cluster.tokenValue) fetchClusterOptions(cluster);
      };

      const urlInput = document.createElement("input");
      urlInput.type = "text";
      urlInput.autocomplete = "off";
      urlInput.name = `sm-rancher-url-${index}`;
      urlInput.value = cluster.rancherUrl || "";
      // Luôn cho sửa URL kể cả entry đã lưu (trước đây khoá `readOnly = !cluster.isNew` vĩnh viễn
      // sau lần lưu đầu — bug thật đã báo "không sửa được Rancher URL"). Rancher Key (cluster.name)
      // CHỈ tự derive lại khi cluster.isNew (xem listener "input" bên dưới) — sửa URL của entry đã
      // lưu không đổi Key, tránh gãy tham chiếu env.rancherKey ở Connection String.
      urlInput.placeholder = "https://rancher.example.com";
      urlInput.title = cluster.isNew
        ? ""
        : "Sửa URL không đổi Rancher Key (vẫn giữ nguyên tham chiếu ở Connection String).";
      urlInput.addEventListener("input", () => {
        cluster.rancherUrl = urlInput.value.trim();
        if (cluster.isNew) {
          cluster.name = deriveUniqueRancherKey(cluster, state.rancherClusters);
          if (!cluster.tokenEnvVarManuallySet) {
            cluster.tokenEnvVar = slugEnvVar(cluster.name, "_TOKEN");
          }
        }
      });
      urlInput.addEventListener("blur", maybeFetchClusterOptions);
      urlCell.appendChild(urlInput);

      const tokenInput = document.createElement("input");
      tokenInput.type = "password";
      tokenInput.autocomplete = "new-password";
      tokenInput.name = `sm-rancher-token-${index}`;
      tokenInput.placeholder = cluster.hasValue ? MASKED_PLACEHOLDER : "chưa có giá trị";
      tokenInput.title = cluster.hasValue ? "Đã có giá trị lưu sẵn — để trống nếu không muốn đổi." : "";
      tokenInput.value = cluster.tokenValue || "";
      tokenInput.addEventListener("input", () => {
        cluster.tokenValue = tokenInput.value;
      });
      tokenInput.addEventListener("blur", maybeFetchClusterOptions);
      // Chỉ gọi API reveal thật khi field THẬT SỰ có giá trị đã lưu (!isNew + hasValue) VÀ endpoint
      // được truyền vào (scripts/wizard.html không truyền endpoint này — giữ hành vi cũ ở đó, không
      // cần đụng server raw-http riêng của wizard.js).
      const revealTokenCb =
        !cluster.isNew && cluster.hasValue && endpoints.revealRancherToken
          ? async () => {
              const body = await fetch(endpoints.revealRancherToken, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: cluster.name })
              }).then((r) => r.json());
              if (!body.success) throw new Error(body.message || "Lỗi không xác định");
              return body.data.value;
            }
          : null;
      tokenCell.appendChild(attachPasswordToggle(tokenInput, revealTokenCb));

      clusterIdCell.appendChild(
        buildCascadeCell({
          options: cluster._clusterOptions,
          currentValue: cluster.clusterId,
          manualField: "clusterId",
          manualPlaceholder: "vd: local",
          env: cluster,
          onSelect: (value) => {
            cluster.clusterId = value;
            renderRancherTable();
          }
        })
      );

      // Rancher Key — chỉ xem, không cho sửa (tự sinh từ domain qua deriveUniqueRancherKey()).
      const keySpan = document.createElement("span");
      keySpan.className = "sm-readonly-text";
      keySpan.textContent = cluster.name || "";
      keyCell.appendChild(keySpan);

      const deleteClusterBtn = document.createElement("a");
      deleteClusterBtn.href = "#";
      deleteClusterBtn.className = "sm-btn-delete";
      deleteClusterBtn.innerHTML = '<img src="/assets/delete.png" alt="" />';
      deleteClusterBtn.title = "Xoá cluster";
      deleteClusterBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        const blockedBy = state.dbEnvironments.filter((env) => env.rancherKey === cluster.name);
        if (blockedBy.length) {
          setStatus(
            `Không thể xoá "${cluster.rancherUrl || cluster.name}" — còn ${blockedBy.length} Connection String đang trỏ tới (xoá Connection String đó trước).`,
            "error"
          );
          return;
        }
        const confirmed = await confirmDeleteWithKey({
          keyLabel: "Rancher Key",
          expectedKey: cluster.name,
          itemLabel: cluster.rancherUrl || cluster.name
        });
        if (!confirmed) return;
        const [removed] = state.rancherClusters.splice(index, 1);
        renderRancherTable();
        // Entry đã lưu (!isNew) tồn tại thật trong config/rancher-clusters.json trên đĩa — phải ghi
        // ngay xuống file, không chỉ bỏ khỏi state cục bộ (bug thật đã gặp: xoá trên UI xong không
        // bấm "Áp dụng" → reload trang lại thấy y nguyên, tưởng nhầm là bấm xoá không có tác dụng).
        // Entry mới thêm (isNew, chưa từng lưu) thì không có gì trên đĩa để xoá, bỏ qua gọi API.
        if (!removed.isNew) {
          try {
            await persistRancherClusters();
            setStatus(`Đã xoá "${removed.rancherUrl || removed.name}".`, "success");
          } catch (error) {
            state.rancherClusters.splice(index, 0, removed);
            renderRancherTable();
            setStatus(`Xoá "${removed.rancherUrl || removed.name}" thất bại: ${error.message}`, "error");
          }
        }
      });
      actionsCell.appendChild(deleteClusterBtn);

      // Copy 1 chuỗi định danh duy nhất — mục đích để user dán cho AI hiểu ngay đây là Rancher nào
      // (name/url/clusterId), không dùng icon PNG mới (chỉ có source cho "plus.png" trong yêu cầu
      // này) — tái dùng ký tự ⧉ đúng convention icon copy đã có sẵn ở Object Explorer (index.html).
      const copyClusterBtn = document.createElement("a");
      copyClusterBtn.href = "#";
      copyClusterBtn.className = "sm-btn-copy";
      copyClusterBtn.textContent = "⧉";
      copyClusterBtn.title = "Copy định danh Rancher này";
      copyClusterBtn.addEventListener("click", (e) => {
        e.preventDefault();
        const parts = [`name="${cluster.name}"`, `url="${cluster.rancherUrl}"`, `clusterId="${cluster.clusterId}"`];
        if (cluster.description) parts.push(`description="${cluster.description}"`);
        navigator.clipboard.writeText(`Rancher: ${parts.join(" ")}`).then(() => {
          copyClusterBtn.textContent = "✓";
          setTimeout(() => {
            copyClusterBtn.textContent = "⧉";
          }, 1000);
        });
      });
      actionsCell.appendChild(copyClusterBtn);

      rancherBody.appendChild(row);
    });
    renderRancherKeyOptions();
  }

  function renderRancherKeyOptions() {
    // Combobox ở bảng Connection string phải phản ánh đúng danh sách Rancher Key hiện có (kể cả
    // cluster vừa "Thêm mới" chưa lưu) — gọi lại renderDbEnvTable() để build lại <select>.
    renderDbEnvTable();
  }

  // Gọi API Rancher/k8s THẬT để gợi ý Project/Namespace (không còn Service — DB Host/Port gõ tay
  // dạng "host:port", xem renderDbEnvTable(), vì DB thật thường nằm NGOÀI cluster nên không có gì
  // để gợi ý qua API). 2 nhánh: cluster ĐÃ lưu (đã "Áp dụng", có token trong .env) → GET qua
  // rancherKey; cluster VỪA gõ, chưa lưu (isNew) → POST *-adhoc dùng thẳng URL/token/clusterId đang
  // có sẵn trong state.rancherClusters (không bắt user phải "Áp dụng" trước mới thao tác tiếp được
  // — cùng tinh thần ad-hoc của Cluster ID combobox ở fetchClusterOptions()). Luôn giữ input tay
  // song song với <select> (không thay thế) để không chặn cứng luồng khi API lỗi.
  async function fetchCascade(env, level) {
    const key = `_${level}`;
    const cluster = state.rancherClusters.find((c) => c.name === env.rancherKey);
    const useAdhoc = Boolean(cluster && cluster.isNew);

    if (useAdhoc && (!cluster.rancherUrl || !cluster.tokenValue || !cluster.clusterId)) {
      env[key] = {
        error: true,
        message: 'Rancher này chưa lưu — nhập đủ Rancher URL, Token và chọn Cluster ID (bảng "Danh sách Rancher") trước'
      };
      renderDbEnvTable();
      return;
    }

    env[key] = "loading";
    renderDbEnvTable();
    try {
      let body;
      if (useAdhoc) {
        const adhocEndpoint = { projects: "rancherProjectsAdhoc", namespaces: "rancherNamespacesAdhoc" }[level];
        body = await fetch(endpoints[adhocEndpoint], {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rancherUrl: cluster.rancherUrl,
            token: cluster.tokenValue,
            clusterId: cluster.clusterId,
            insecureTLS: true,
            projectId: level === "namespaces" ? env.projectId : undefined
          })
        }).then((r) => r.json());
      } else {
        const url =
          level === "projects"
            ? `${endpoints.rancherProjects}?rancherKey=${encodeURIComponent(env.rancherKey)}`
            : `${endpoints.rancherNamespaces}?rancherKey=${encodeURIComponent(env.rancherKey)}&projectId=${encodeURIComponent(env.projectId)}`;
        body = await fetch(url).then((r) => r.json());
      }
      if (body.success === false) throw new Error(body.message || "Không tải được danh sách.");
      const data = body.data || [];
      // Chuẩn hoá về {value, label} cho buildCascadeField() — services/rancher.client.js trả
      // {id, name} (projects) hoặc mảng string thuần (namespaces).
      env[key] = level === "projects" ? data.map((p) => ({ value: p.id, label: p.name })) : data.map((ns) => ({ value: ns, label: ns }));
    } catch (error) {
      env[key] = { error: true, message: error.message || "Không tải được." };
    }
    renderDbEnvTable();
  }

  // persistRancherClusters/persistDbEnvironments — ghi TOÀN BỘ state hiện tại xuống file cấu hình
  // tương ứng (POST đè nguyên mảng, xem services/settings.service.js::saveRancherClusters()/
  // saveDbEnvironments()). Dùng chung bởi nút "Áp dụng" VÀ 2 nút xoá (xem deleteClusterBtn/
  // deleteDbEnvBtn) — tách ra để nút xoá ghi ngay xuống đĩa thay vì chỉ sửa state cục bộ chờ "Áp
  // dụng" (đồng bộ hiển thị UI với file thật, tránh reload trang làm mất thao tác xoá).
  async function persistRancherClusters() {
    await fetch(endpoints.rancherClusters, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clusters: state.rancherClusters.map((c) => ({
          name: c.name,
          rancherUrl: c.rancherUrl,
          clusterId: c.clusterId,
          insecureTLS: true,
          tokenEnvVar: c.tokenEnvVar,
          description: c.description
        }))
      })
    }).then(assertOk);
  }

  async function persistDbEnvironments() {
    await fetch(endpoints.dbEnvironments, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        environments: state.dbEnvironments.map((e) => ({
          name: e.name,
          description: e.description,
          connectionStringEnvVar: e.connectionStringEnvVar,
          mode: e.mode,
          domain: e.domain,
          rancherKey: e.rancherKey,
          namespace: e.namespace,
          dbHost: e.dbHost,
          dbPort: e.dbPort,
          projectId: e.projectId,
          existingPodName: e.existingPodName,
          allowWrite: e.allowWrite,
          engine: e.engine
        }))
      })
    }).then(assertOk);
  }

  // fetchPodOptions — nạp dropdown "Pod có sẵn" (existingPodName, dùng cho exec-relay tunnel thay
  // jump pod — xem services/providers/dbtunnel-core.js::openTunnelViaExec()). 2 nhánh: entry ĐÃ "Áp
  // dụng" (!env.isNew) → GET /pods/for-db-env đọc THẲNG config/db-environments.json đã lưu trên đĩa
  // (getEnvironmentOrThrow); entry CHƯA lưu (isNew) → POST endpoints.dbEnvPodsAdhoc dùng thẳng
  // namespace/projectId + rancherKey (đã lưu) hoặc rancherUrl/token/clusterId (cluster cũng isNew,
  // qua resolveRancherTarget()) đang gõ trên UI — không cần "Áp dụng" trước, cùng tinh thần
  // fetchCascade()/fetchClusterOptions(). wizard.html (cài đặt lần đầu) không truyền endpoints này —
  // bỏ qua fetch, ô chỉ còn nhập tay (đúng ý: máy mới cài chưa có gì để liệt kê).
  async function fetchPodOptions(env) {
    env._pods = "loading";
    renderDbEnvTable();
    try {
      let body;
      if (!env.isNew) {
        if (!endpoints.dbEnvPods) return;
        const url = `${endpoints.dbEnvPods}?dbEnv=${encodeURIComponent(env.name)}`;
        body = await fetch(url).then((r) => r.json());
      } else {
        if (!endpoints.dbEnvPodsAdhoc) return;
        const target = resolveRancherTarget(env);
        if (!target || target.incomplete) {
          env._pods = { error: true, message: 'Rancher này chưa lưu — nhập đủ Rancher URL, Token và chọn Cluster ID (bảng "Danh sách Rancher") trước' };
          renderDbEnvTable();
          return;
        }
        body = await fetch(endpoints.dbEnvPodsAdhoc, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...target, namespace: env.namespace, projectId: env.projectId })
        }).then((r) => r.json());
      }
      if (body.success === false) throw new Error(body.message || "Không tải được danh sách pod.");
      env._pods = (body.data || []).map((pod) => ({ value: pod.name, label: pod.name }));
    } catch (error) {
      env._pods = { error: true, message: error.message || "Không tải được danh sách pod." };
    }
    renderDbEnvTable();
  }

  // Kiểm tra kết nối THẬT — 2 nhánh: entry ĐÃ "Áp dụng" (!env.isNew) → POST endpoints.testDbConnection
  // {name}, server tự đọc connection string đã lưu (kể cả phải mở k8s-tunnel) rồi chạy 1 lệnh vô hại
  // (SELECT 1/Mongo ping, KHÔNG side-effect); entry CHƯA lưu (isNew) → POST
  // endpoints.testDbConnectionAdhoc, gửi THẲNG connectionString + rancherKey/adhoc creds +
  // namespace/dbHost/dbPort/projectId/existingPodName đang gõ trên dòng hiện tại (server mở tunnel
  // 1 lần dùng rồi đóng ngay, không cần "Áp dụng" để lưu file trước) — xem
  // services/db.service.js::testConnectionAdhoc(). Kết quả {success, allowWrite?} — nhánh đã lưu lấy
  // allowWrite từ config THẬT trên server; nhánh ad-hoc chưa có gì lưu trên đĩa nên dùng
  // state.env.allowWrite của FE (mặc định true lúc "Thêm mới") để tô icon.
  async function testConnection(env) {
    env._testStatus = { kind: "loading" };
    renderDbEnvTable();
    try {
      let body;
      if (!env.isNew) {
        body = await fetch(endpoints.testDbConnection, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: env.name })
        }).then((r) => r.json());
      } else {
        if (!endpoints.testDbConnectionAdhoc) throw new Error("Không hỗ trợ kiểm tra kết nối cho entry chưa lưu.");
        const target = resolveRancherTarget(env);
        if (target && target.incomplete) {
          throw new Error('Rancher này chưa lưu — nhập đủ Rancher URL, Token và chọn Cluster ID (bảng "Danh sách Rancher") trước.');
        }
        body = await fetch(endpoints.testDbConnectionAdhoc, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connectionString: env.urlValue,
            namespace: env.namespace,
            projectId: env.projectId,
            dbHost: env.dbHost,
            dbPort: env.dbPort,
            existingPodName: env.existingPodName,
            ...(target || {})
          })
        }).then((r) => r.json());
      }
      // Lỗi có thể xảy ra ở 2 tầng: (1) request/controller lỗi trước khi tới testConnection() —
      // envelope KHÔNG có "data", message nằm ở body.message (vd env không tồn tại, lỗi validate);
      // (2) testConnection() chạy được nhưng ping() thất bại — envelope có "data.success=false" +
      // "data.message" (vd sai host/token/timeout). Trước đây chỉ đọc data.message nên nhánh (1) bị
      // nuốt mất, luôn hiện "Kết nối thất bại." chung chung dù lỗi thật rất khác nhau.
      if (body.success === false) {
        env._testStatus = { kind: "fail", message: body.message || "Kết nối thất bại." };
      } else {
        const data = body.data || {};
        if (data.success) {
          const allowWrite = env.isNew ? Boolean(env.allowWrite) : Boolean(data.allowWrite);
          env._testStatus = { kind: allowWrite ? "success-write" : "success-readonly" };
        } else {
          env._testStatus = { kind: "fail", message: data.message || "Kết nối thất bại." };
        }
      }
    } catch (error) {
      env._testStatus = { kind: "fail", message: error.message || "Kết nối thất bại." };
    }
    if (env._testStatus.kind === "fail") {
      setStatus(`Kiểm tra kết nối "${env.name || "(chưa đặt tên)"}" thất bại: ${env._testStatus.message}`, "error");
    }
    renderDbEnvTable();
  }

  // Không còn dùng <label> riêng (header cột bảng đã ghi rõ ý nghĩa) — dùng trực tiếp trong <td>
  // của hàng chính, thay cho hàng phụ (sm-expand-row) trước đây.
  function buildCascadeCell({ options, currentValue, onSelect, manualField, manualPlaceholder, onManualInput, env, disabled }) {
    const wrap = document.createElement("div");
    wrap.className = "sm-cascade-cell";

    // Cho phép ép sang chế độ nhập tay dù select có dữ liệu — trường hợp thật đã gặp: resource
    // (vd namespace) tồn tại thật trên cluster nhưng không gán vào Rancher Project đang chọn nên
    // API cascade không trả về, mà trước đây select có dữ liệu thì ô nhập tay bị ẩn hẳn, không có
    // đường nào gõ tay giá trị đúng. Cờ theo từng field, gắn trực tiếp lên `env`/`cluster` object.
    const overrideKey = manualField ? `_manualOverride_${manualField}` : null;
    const manualOverride = Boolean(overrideKey && env && env[overrideKey]);
    const hadPopulatedOptions = Array.isArray(options) && options.length > 0;

    if (!manualOverride) {
      if (options === "loading") {
        const hint = document.createElement("div");
        hint.className = "sm-cascade-hint";
        hint.textContent = "Đang tải...";
        wrap.appendChild(hint);
      } else if (Array.isArray(options)) {
        if (options.length) {
          const select = document.createElement("select");
          select.disabled = Boolean(disabled);
          const emptyOpt = document.createElement("option");
          emptyOpt.value = "";
          emptyOpt.textContent = "-- chọn --";
          select.appendChild(emptyOpt);
          options.forEach((opt) => {
            const o = document.createElement("option");
            o.value = opt.value;
            o.textContent = opt.label;
            if (opt.value === currentValue) o.selected = true;
            select.appendChild(o);
          });
          if (manualField) {
            const manualOpt = document.createElement("option");
            manualOpt.value = MANUAL_OVERRIDE_SENTINEL;
            manualOpt.textContent = "-- nhập tay (không có trong danh sách) --";
            select.appendChild(manualOpt);
          }
          select.addEventListener("change", () => {
            if (manualField && select.value === MANUAL_OVERRIDE_SENTINEL) {
              env[overrideKey] = true;
              renderDbEnvTable();
              return;
            }
            onSelect(select.value, options.find((o) => o.value === select.value));
          });
          wrap.appendChild(select);
        } else {
          const hint = document.createElement("div");
          hint.className = "sm-cascade-hint";
          hint.textContent = "Không có mục nào — nhập tay bên dưới.";
          wrap.appendChild(hint);
        }
      } else if (options && options.error) {
        const hint = document.createElement("div");
        hint.className = "sm-cascade-hint error";
        hint.textContent = `${options.message || "Không tải được."} — nhập tay bên dưới.`;
        wrap.appendChild(hint);
      }
    }

    // Chỉ hiện ô nhập tay khi KHÔNG có select với dữ liệu thật ĐANG hiển thị (loading/lỗi/chưa có
    // gì/mảng rỗng), HOẶC người dùng vừa chủ động chọn "-- nhập tay --" ở trên — tránh hiện đồng
    // thời combobox + textbox trùng giá trị khi không cần (dư thừa, gây rối — bug thật đã gặp).
    const hasPopulatedSelect = !manualOverride && hadPopulatedOptions;
    if (manualField && !hasPopulatedSelect) {
      const manualInput = document.createElement("input");
      manualInput.type = "text";
      manualInput.autocomplete = "off";
      manualInput.placeholder = manualPlaceholder || "hoặc nhập tay";
      manualInput.value = currentValue || "";
      manualInput.disabled = Boolean(disabled);
      manualInput.addEventListener("input", () => {
        env[manualField] = manualInput.value.trim();
        if (onManualInput) onManualInput();
      });
      wrap.appendChild(manualInput);

      if (manualOverride && hadPopulatedOptions) {
        const backLink = document.createElement("a");
        backLink.href = "#";
        backLink.className = "sm-cascade-back";
        backLink.textContent = "↺ Chọn lại từ danh sách";
        backLink.addEventListener("click", (e) => {
          e.preventDefault();
          env[overrideKey] = false;
          renderDbEnvTable();
        });
        wrap.appendChild(backLink);
      }
    }

    return wrap;
  }

  // URL KEY tự sinh nên chỉ tính lại khi entry còn "isNew" (entry đã lưu khoá cứng field định
  // danh — cùng tinh thần khoá Rancher Key sau khi tạo ở bảng trên, tránh gãy tham chiếu).
  function recomputeDbEnvKey(env) {
    if (!env.isNew) return;
    env.name = deriveDbEnvKey(env);
    if (!env.connectionStringEnvVarManuallySet) {
      env.connectionStringEnvVar = slugEnvVar(env.name, "_URL");
    }
  }

  function renderDbEnvTable() {
    dbEnvBody.innerHTML = "";
    const clusters = state.rancherClusters.filter((c) => c.name);

    state.dbEnvironments.forEach((env, index) => {
      const row = document.createElement("div");
      row.className = "sm-card";

      const descHeader = createDescHeader({
        index: index + 1,
        getValue: () => env.description,
        onCommit: (value) => {
          env.description = value;
        },
        placeholder: "Mô tả (tuỳ chọn)",
        withStatus: true,
        icon: "/assets/connect.png",
        iconAlt: "Connect",
        labelPrefix: "Connect"
      });
      row.appendChild(descHeader.header);
      const actionsCell = descHeader.actionsSlot;
      const allowWriteCell = descHeader.statusSlot;

      // URL Key — trước đây không hiển thị ở đâu trên card này (khác Rancher Key ở bảng trên) dù
      // đã dùng làm định danh tham chiếu nội bộ (env.name) — thêm hiển thị readonly để user có chỗ
      // đọc/đối chiếu khi gõ lại xác nhận xoá (xem confirmDeleteWithKey()) và khi copy định danh.
      const urlKeyField = createField("URL Key");
      row.appendChild(urlKeyField.field);
      const urlKeySpan = document.createElement("span");
      urlKeySpan.className = "sm-readonly-text";
      urlKeySpan.textContent = env.name || "";
      urlKeyField.value.appendChild(urlKeySpan);

      const rancherField = createField("Rancher");
      row.appendChild(rancherField.field);
      const rancherCell = rancherField.value;

      const projectField = createField("Project");
      row.appendChild(projectField.field);
      const projectCell = projectField.value;

      const namespaceField = createField("Namespace");
      row.appendChild(namespaceField.field);
      const namespaceCell = namespaceField.value;

      const connStringField = createField("Connection String");
      row.appendChild(connStringField.field);
      const connStringCell = connStringField.value;

      const dbHostPortField = createField("DB Host/Port");
      row.appendChild(dbHostPortField.field);
      const dbHostPortCell = dbHostPortField.value;

      const existingPodField = createField("Pod có sẵn");
      row.appendChild(existingPodField.field);
      const existingPodCell = existingPodField.value;

      const locked = !env.isNew;

      const rancherSelect = document.createElement("select");
      rancherSelect.disabled = locked;
      const emptyOption = document.createElement("option");
      emptyOption.value = "";
      emptyOption.textContent = "Không dùng";
      rancherSelect.appendChild(emptyOption);
      clusters.forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c.name;
        opt.textContent = c.name;
        opt.title = c.rancherUrl || "";
        if (env.rancherKey === c.name) opt.selected = true;
        rancherSelect.appendChild(opt);
      });
      rancherSelect.addEventListener("change", () => {
        env.rancherKey = rancherSelect.value || undefined;
        env.mode = env.rancherKey ? "k8s-tunnel" : undefined;
        env.projectId = "";
        env.namespace = "";
        env.dbHost = "";
        env.dbPort = "";
        env._projects = env._namespaces = null;
        env._testStatus = null;
        resetPodsCache(env);
        recomputeDbEnvKey(env);
        renderDbEnvTable();
        if (env.rancherKey) fetchCascade(env, "projects");
      });
      rancherCell.appendChild(rancherSelect);

      // Entry cũ dùng cơ chế k8s-tunnel qua `domain` (khớp entry namespaces.json, xem "Config
      // files" trong CLAUDE.md) thay vì `rancherKey` trực tiếp — UI này chỉ hỗ trợ sửa nhánh
      // rancherKey, nhưng vẫn phải HIỆN RA domain cũ để không trông như hàng trống/mất dữ liệu.
      if (env.domain && !env.rancherKey) {
        const domainHint = document.createElement("div");
        domainHint.className = "sm-cascade-hint";
        domainHint.textContent = `k8s-tunnel qua domain (cũ): ${env.domain}`;
        rancherCell.appendChild(domainHint);
      }

      // Dòng đã lưu (locked) chỉ giữ projectId thô trong config, không có tên thân thiện đi kèm —
      // tự fetch 1 lần để resolve ra tên hiển thị (select bị disabled nên vẫn chỉ đọc, không cho
      // sửa) thay vì hiện thẳng ID khó hiểu. Defer qua microtask để không gọi renderDbEnvTable()
      // lồng ngay trong chính lượt render đang chạy (fetchCascade tự render lại khi xong).
      if (locked && env.rancherKey && !env._projects) {
        Promise.resolve().then(() => fetchCascade(env, "projects"));
      }

      projectCell.appendChild(
        buildCascadeCell({
          options: env.rancherKey ? env._projects : undefined,
          currentValue: env.projectId,
          manualField: "projectId",
          manualPlaceholder: "hoặc nhập tay Project ID",
          onManualInput: () => {
            env._testStatus = null;
            resetPodsCache(env);
            recomputeDbEnvKey(env);
          },
          env,
          disabled: locked || !env.rancherKey,
          onSelect: (value) => {
            env.projectId = value;
            env.namespace = "";
            env.dbHost = "";
            env.dbPort = "";
            env._namespaces = null;
            env._testStatus = null;
            resetPodsCache(env);
            recomputeDbEnvKey(env);
            renderDbEnvTable();
            fetchCascade(env, "namespaces");
          }
        })
      );

      namespaceCell.appendChild(
        buildCascadeCell({
          options: env.projectId ? env._namespaces : undefined,
          currentValue: env.namespace,
          manualField: "namespace",
          manualPlaceholder: "hoặc nhập tay Namespace",
          onManualInput: () => {
            env._testStatus = null;
            resetPodsCache(env);
            recomputeDbEnvKey(env);
          },
          env,
          disabled: locked || !env.projectId,
          onSelect: (value) => {
            env.namespace = value;
            env.dbHost = "";
            env.dbPort = "";
            env._testStatus = null;
            resetPodsCache(env);
            recomputeDbEnvKey(env);
            renderDbEnvTable();
          }
        })
      );

      // KHÔNG còn dropdown gợi ý Service — Rancher API chỉ liệt kê được Service tồn tại TRONG
      // cluster, trong khi DB Host/Port thực tế thường là 1 địa chỉ NGOÀI cluster (vd DB demo
      // 10.163.147.76:31001) không có cách nào "khám phá" qua API. Gõ tay 1 ô duy nhất dạng
      // "host:port" — dbtunnel-core.js::buildPodManifest chỉ cần đúng 2 giá trị này để socat forward
      // TCP tới, không quan tâm đó có phải k8s Service hay không. TỰ ĐIỀN + khoá ô này khi
      // Connection String đã chứa sẵn host:port thật (parseHostPortFromConnectionString()) — tránh
      // bắt gõ trùng thông tin đã có trong Connection String.
      const dbHostPortInput = document.createElement("input");
      dbHostPortInput.type = "text";
      dbHostPortInput.autocomplete = "off";
      dbHostPortInput.placeholder = "host:port, vd: 10.163.147.76:31001";
      dbHostPortInput.value = env.dbHost ? `${env.dbHost}${env.dbPort ? `:${env.dbPort}` : ""}` : "";
      dbHostPortInput.disabled = locked;
      dbHostPortInput.addEventListener("input", () => {
        const raw = dbHostPortInput.value.trim();
        const m = raw.match(/^(.+):(\d+)$/);
        if (m) {
          env.dbHost = m[1].trim();
          env.dbPort = m[2].trim();
        } else {
          env.dbHost = raw;
          env.dbPort = "";
        }
        env._testStatus = null;
        recomputeDbEnvKey(env);
      });
      dbHostPortCell.appendChild(dbHostPortInput);

      function applyParsedHostPort() {
        const parsed = parseHostPortFromConnectionString(env.urlValue);
        if (parsed) {
          env.dbHost = parsed.host;
          env.dbPort = parsed.port;
          dbHostPortInput.value = `${parsed.host}:${parsed.port}`;
          dbHostPortInput.disabled = true;
          dbHostPortInput.title = "Tự lấy từ Connection String";
        } else {
          dbHostPortInput.disabled = locked;
          dbHostPortInput.title = "";
        }
        recomputeDbEnvKey(env);
      }
      applyParsedHostPort();

      const connStringInput = document.createElement("input");
      connStringInput.type = "password";
      connStringInput.autocomplete = "new-password";
      connStringInput.name = `sm-dbenv-value-${index}`;
      connStringInput.placeholder = env.hasValue ? MASKED_PLACEHOLDER : "chưa có giá trị";
      connStringInput.title = env.hasValue
        ? "Đã có giá trị lưu sẵn — để trống nếu không muốn đổi."
        : env.rancherKey
          ? "Dán nguyên connection string thật (có host:port) — tool tự thay bằng __HOST__ khi lưu để đi qua tunnel."
          : "";
      connStringInput.value = env.urlValue || "";
      connStringInput.addEventListener("input", () => {
        env.urlValue = connStringInput.value;
        env._testStatus = null;
        applyParsedHostPort();
      });
      const revealConnStringCb =
        !env.isNew && env.hasValue && endpoints.revealDbEnvironmentValue
          ? async () => {
              const body = await fetch(endpoints.revealDbEnvironmentValue, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: env.name })
              }).then((r) => r.json());
              if (!body.success) throw new Error(body.message || "Lỗi không xác định");
              return body.data.value;
            }
          : null;
      connStringCell.appendChild(attachPasswordToggle(connStringInput, revealConnStringCb));

      // Pod có sẵn (existingPodName) — nạp dropdown khi đủ rancherKey/namespace/projectId, kể cả
      // entry CHƯA "Áp dụng" (isNew) — dùng nhánh ad-hoc (endpoints.dbEnvPodsAdhoc, xem
      // fetchPodOptions() ở trên) thay vì bắt lưu file trước. Entry chưa đủ thông tin vẫn cho nhập
      // tay qua manualField — không tạo/xoá pod nào, chỉ để trống = giữ nguyên hành vi jump pod mặc định.
      const podPickerEligible = Boolean(
        env.rancherKey && env.namespace && env.projectId && (env.isNew ? endpoints.dbEnvPodsAdhoc : endpoints.dbEnvPods)
      );
      if (podPickerEligible && !env._pods) {
        Promise.resolve().then(() => fetchPodOptions(env));
      }
      existingPodCell.appendChild(
        buildCascadeCell({
          options: podPickerEligible ? env._pods : undefined,
          currentValue: env.existingPodName,
          manualField: "existingPodName",
          manualPlaceholder: "hoặc nhập tay tên pod (để trống = jump pod mặc định)",
          env,
          disabled: false,
          onSelect: (value) => {
            env.existingPodName = value || undefined;
          }
        })
      );

      // Checkbox "Cho phép ghi" đã ẩn khỏi UI theo yêu cầu — env.allowWrite vẫn giữ nguyên trong
      // state/payload (mặc định true lúc "Thêm mới", xem btnAddDbEnv bên dưới), chỉ không cho sửa
      // tay trực tiếp qua bảng này nữa. Cột này giờ hiện trạng thái kiểm tra kết nối thật.
      renderStatusCell(allowWriteCell, env);

      const deleteDbEnvBtn = document.createElement("a");
      deleteDbEnvBtn.href = "#";
      deleteDbEnvBtn.className = "sm-btn-delete";
      deleteDbEnvBtn.innerHTML = '<img src="/assets/delete.png" alt="" />';
      deleteDbEnvBtn.title = "Xoá connection";
      deleteDbEnvBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        const confirmed = await confirmDeleteWithKey({
          keyLabel: "URL Key",
          expectedKey: env.name,
          itemLabel: env.name || "(chưa đặt tên)"
        });
        if (!confirmed) return;
        const [removed] = state.dbEnvironments.splice(index, 1);
        renderDbEnvTable();
        // Cùng lý do với deleteClusterBtn ở trên — entry đã lưu phải ghi file ngay, không chờ "Áp
        // dụng", tránh reload trang làm mất thao tác xoá tưởng đã xong.
        if (!removed.isNew) {
          try {
            await persistDbEnvironments();
            setStatus(`Đã xoá connection "${removed.name || "(chưa đặt tên)"}".`, "success");
          } catch (error) {
            state.dbEnvironments.splice(index, 0, removed);
            renderDbEnvTable();
            setStatus(`Xoá connection "${removed.name || "(chưa đặt tên)"}" thất bại: ${error.message}`, "error");
          }
        }
      });

      // Chỉ hiện khi component được gọi với endpoints.testDbConnection (popup Cấu hình live —
      // wizard quickstart không truyền field này vì mọi entry ở đó đều isNew, chưa có gì để test).
      // Entry ĐÃ "Áp dụng" (!isNew) luôn bật. Entry CHƯA lưu (isNew) cũng bật được — qua
      // endpoints.testDbConnectionAdhoc (xem testConnection() ở trên) — miễn đã gõ đủ Connection
      // String + (nếu chọn Rancher, dùng k8s-tunnel) Namespace/Project/DB Host/Port, không cần "Áp
      // dụng" trước.
      if (endpoints.testDbConnection) {
        const testEligible =
          !env.isNew ||
          Boolean(endpoints.testDbConnectionAdhoc && env.urlValue && (!env.rancherKey || (env.namespace && env.projectId && env.dbHost && env.dbPort)));
        const testBtn = document.createElement("a");
        testBtn.href = "#";
        testBtn.className = testEligible ? "sm-btn-test" : "sm-btn-test disabled";
        testBtn.innerHTML = '<img src="/assets/test-connection.png" alt="" />';
        testBtn.title = testEligible
          ? "Kiểm tra kết nối"
          : "Nhập đủ Connection String" + (env.rancherKey ? "/Namespace/Project/DB Host/Port" : "") + " trước khi kiểm tra";
        testBtn.addEventListener("click", (e) => {
          e.preventDefault();
          if (!testEligible) return;
          testConnection(env);
        });
        actionsCell.appendChild(testBtn);
      }
      actionsCell.appendChild(deleteDbEnvBtn);

      // Copy định danh duy nhất — rancherKey trong chuỗi này TRÙNG với name của Rancher tương ứng
      // (copyClusterBtn ở trên) nên AI đọc riêng lẻ 2 chuỗi vẫn tự nối được "connection này thuộc
      // rancher nào" qua so khớp giá trị, không cần thêm field nào khác.
      const copyDbEnvBtn = document.createElement("a");
      copyDbEnvBtn.href = "#";
      copyDbEnvBtn.className = "sm-btn-copy";
      copyDbEnvBtn.textContent = "⧉";
      copyDbEnvBtn.title = "Copy định danh connection này";
      copyDbEnvBtn.addEventListener("click", (e) => {
        e.preventDefault();
        const parts = [
          `name="${env.name}"`,
          `engine="${env.engine || ""}"`,
          `rancherKey="${env.rancherKey || "(không dùng Rancher)"}"`,
          `dbHost="${env.dbHost || ""}"`,
          `dbPort="${env.dbPort || ""}"`,
          `allowWrite=${Boolean(env.allowWrite)}`
        ];
        if (env.description) parts.push(`description="${env.description}"`);
        navigator.clipboard.writeText(`Connection: ${parts.join(" ")}`).then(() => {
          copyDbEnvBtn.textContent = "✓";
          setTimeout(() => {
            copyDbEnvBtn.textContent = "⧉";
          }, 1000);
        });
      });
      actionsCell.appendChild(copyDbEnvBtn);

      dbEnvBody.appendChild(row);
    });
  }

  btnAddCluster.addEventListener("click", (e) => {
    e.preventDefault();
    state.rancherClusters.push({
      name: "",
      rancherUrl: "",
      clusterId: "",
      insecureTLS: true,
      tokenEnvVar: "",
      description: "",
      hasValue: false,
      tokenValue: "",
      isNew: true
    });
    renderRancherTable();
  });

  btnAddDbEnv.addEventListener("click", (e) => {
    e.preventDefault();
    state.dbEnvironments.push({
      name: "",
      description: "",
      connectionStringEnvVar: "",
      allowWrite: true,
      hasValue: false,
      urlValue: "",
      isNew: true
    });
    renderDbEnvTable();
  });

  // k8sql cài đặt qua gói OS chuẩn (.deb/.AppImage/.msi/.dmg) — không có khái niệm "thư mục cài
  // đặt" tuỳ chọn như k8sctl (installer bash tự viết, cho phép trỏ vào bất kỳ đâu kể cả thư mục
  // dev). Đã bỏ hẳn ô "Thư mục cài đặt" + nút "Chọn thư mục..." khỏi UI (quyết định kiến trúc, xem
  // k8sql/CLAUDE.md mục "Việc KHÔNG port") — endpoints.browseDirectory không còn được gọi ở đây.

  if (autostartToggle && endpoints.autostart) {
    fetch(endpoints.autostart)
      .then((r) => r.json())
      .then((body) => {
        autostartToggle.checked = Boolean(body.enabled);
      })
      .catch(() => {
        // Native bridge (Rust) có thể chưa sẵn sàng ngay lúc mở modal — im lặng giữ trạng thái mặc
        // định (unchecked), không chặn phần còn lại của Settings hoạt động.
      });

    autostartToggle.addEventListener("change", async () => {
      const desired = autostartToggle.checked;
      autostartToggle.disabled = true;
      try {
        const res = await fetch(endpoints.autostart, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: desired })
        }).then(assertOk);
        autostartToggle.checked = Boolean(res.data?.enabled);
      } catch (error) {
        autostartToggle.checked = !desired; // rollback UI nếu lỗi
        setStatus(error.message || "Không đổi được cài đặt khởi động cùng hệ thống.", "error");
      } finally {
        autostartToggle.disabled = false;
      }
    });
  }

  btnClose.addEventListener("click", () => {
    if (onClose) onClose();
  });

  btnApply.addEventListener("click", async () => {
    setStatus("Đang lưu...", "");
    btnApply.disabled = true;
    try {
      for (const cluster of state.rancherClusters) {
        if (!cluster.rancherUrl || !cluster.name || !cluster.tokenEnvVar) {
          throw new Error("Rancher URL không được để trống.");
        }
      }
      // Chỉ so được token VỪA GÕ trong phiên hiện tại (token cũ đã lưu bị mask, không đọc lại được)
      // — nhóm theo domain (deriveKeyFromUrl), chặn nếu 2 dòng cùng domain gõ trùng 1 token.
      {
        const byDomain = new Map();
        state.rancherClusters.forEach((c) => {
          if (!c.tokenValue) return;
          const domainKey = deriveKeyFromUrl(c.rancherUrl);
          const seen = byDomain.get(domainKey) || new Set();
          if (seen.has(c.tokenValue)) {
            throw new Error(`2 Rancher cùng domain "${c.rancherUrl}" đang khai trùng giá trị token — mỗi dòng phải dùng 1 token khác nhau.`);
          }
          seen.add(c.tokenValue);
          byDomain.set(domainKey, seen);
        });
      }
      for (const env of state.dbEnvironments) {
        if (!env.name || !env.connectionStringEnvVar) {
          throw new Error("Chọn Rancher/Namespace/DB Host hoặc nhập Connection String trước khi lưu.");
        }
      }

      await persistRancherClusters();
      await persistDbEnvironments();

      // KHÔNG gửi "PORT" — UI này không có field chỉnh port (xem CLAUDE.md "Port KHÔNG còn hiển
      // thị trên UI"), giá trị PORT thật của mỗi máy có thể khác 3210 (vd đã đổi tay trong .env để
      // chạy song song nhiều instance). Bỏ trống = apply-env-values.sh tự giữ nguyên giá trị cũ
      // trong .env — gửi cứng "3210" ở đây từng ghi đè nhầm PORT thật, khiến service bật lại ở port
      // khác cổng UI đang mở, mọi fetch() sau đó "Failed to fetch" (bug thật đã gặp, xem team-notes).
      const values = {};
      state.rancherClusters.forEach((c) => {
        if (c.tokenValue) values[c.tokenEnvVar] = c.tokenValue;
      });
      state.dbEnvironments.forEach((e) => {
        if (e.urlValue) {
          values[e.connectionStringEnvVar] = e.rancherKey ? toTunnelConnectionTemplate(e.urlValue) : e.urlValue;
        }
      });

      const applyRes = await fetch(endpoints.apply, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values })
      }).then(assertOk);

      setStatus(applyRes.data?.message || "Đã áp dụng.", "success");
      if (onApplied) onApplied();
    } catch (error) {
      setStatus(error.message || "Có lỗi xảy ra.", "error");
    } finally {
      btnApply.disabled = false;
    }
  });

  async function assertOk(res) {
    const body = await res.json();
    if (!res.ok || body.success === false) {
      throw new Error(body.message || "Yêu cầu thất bại.");
    }
    return body;
  }

  async function load() {
    const [current, clusters, dbEnvironments] = await Promise.all([
      fetch(endpoints.current).then((r) => r.json()),
      fetch(endpoints.rancherClusters).then((r) => r.json()),
      fetch(endpoints.dbEnvironments).then((r) => r.json())
    ]);

    state.rancherClusters = (clusters.data || []).map((c) => ({ ...c, tokenValue: "", isNew: false }));
    state.dbEnvironments = (dbEnvironments.data || []).map((e) => ({ ...e, urlValue: "", isNew: false }));
    renderRancherTable();
    renderDbEnvTable();
  }

  await load();

  return { reload: load };
}
