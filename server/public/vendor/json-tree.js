"use strict";
// json-tree.js — cây JSON thu gọn/mở rộng đơn giản, TỰ VIẾT (không vendor thư viện ngoài nào) cho
// kết quả query MongoDB trong SQL Tool (xem public/index.html::renderResultJsonTree()). Không phải
// module ESM (khác codemirror.bundle.js) — gắn thẳng window.renderJsonTree, nạp qua <script> thường
// TRƯỚC script type="module" chính trong index.html để chắc chắn đã sẵn sàng khi cần dùng.
//
// Nhận diện thêm 2 dạng Extended JSON mà k8sctl tự trả về (bson.EJSON.serialize ở
// services/providers/mongo/query.js): {"$oid": "..."} -> hiển thị ObjectId("..."), {"$date": "..."}
// -> hiển thị ISODate("...").
(function () {
  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  function describeValue(value) {
    if (value === null || value === undefined) return { type: "null", text: "null" };
    if (Array.isArray(value)) return { type: "array" };
    if (isPlainObject(value)) {
      const keys = Object.keys(value);
      if (keys.length === 1 && typeof value.$oid === "string") {
        return { type: "objectId", text: `ObjectId("${value.$oid}")` };
      }
      if (keys.length === 1 && typeof value.$date === "string") {
        return { type: "date", text: `ISODate("${value.$date}")` };
      }
      return { type: "object" };
    }
    if (typeof value === "string") return { type: "string", text: JSON.stringify(value) };
    if (typeof value === "boolean") return { type: "boolean", text: String(value) };
    if (typeof value === "number") return { type: "number", text: String(value) };
    return { type: "unknown", text: String(value) };
  }

  function buildNode(key, value, depth) {
    const desc = describeValue(value);
    const wrap = document.createElement("div");
    const row = document.createElement("div");
    row.className = "json-row";
    wrap.appendChild(row);

    if (desc.type === "object" || desc.type === "array") {
      const entries = desc.type === "array" ? value.map((v, i) => [i, v]) : Object.entries(value);

      const toggle = document.createElement("span");
      toggle.className = "json-toggle";
      toggle.textContent = entries.length ? "▾" : " ";
      row.appendChild(toggle);

      if (key !== undefined) {
        const keyEl = document.createElement("span");
        keyEl.className = "json-key";
        keyEl.textContent = `${key}: `;
        row.appendChild(keyEl);
      }

      const bracket = document.createElement("span");
      bracket.className = "json-bracket";
      bracket.textContent = desc.type === "array" ? `Array(${entries.length})` : `Object(${entries.length})`;
      row.appendChild(bracket);

      const childrenWrap = document.createElement("div");
      childrenWrap.className = "json-children";
      for (const [childKey, childValue] of entries) {
        childrenWrap.appendChild(buildNode(childKey, childValue, depth + 1));
      }
      wrap.appendChild(childrenWrap);

      // Mặc định chỉ mở sẵn cấp gốc (depth 0) — document lồng sâu không làm cây dài vô tận khi mới render.
      let expanded = depth < 1;
      childrenWrap.style.display = expanded ? "" : "none";
      if (entries.length) {
        toggle.style.cursor = "pointer";
        toggle.addEventListener("click", () => {
          expanded = !expanded;
          childrenWrap.style.display = expanded ? "" : "none";
          toggle.textContent = expanded ? "▾" : "▸";
        });
      }
      return wrap;
    }

    const spacer = document.createElement("span");
    spacer.className = "json-toggle";
    spacer.textContent = " ";
    row.appendChild(spacer);

    if (key !== undefined) {
      const keyEl = document.createElement("span");
      keyEl.className = "json-key";
      keyEl.textContent = `${key}: `;
      row.appendChild(keyEl);
    }

    const valueEl = document.createElement("span");
    valueEl.className = `json-value json-${desc.type}`;
    valueEl.textContent = desc.text;
    row.appendChild(valueEl);
    return wrap;
  }

  function renderJsonTree(value) {
    const root = document.createElement("div");
    root.className = "json-tree";
    root.appendChild(buildNode(undefined, value, 0));
    return root;
  }

  window.renderJsonTree = renderJsonTree;
})();
