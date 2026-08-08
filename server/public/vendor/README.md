# codemirror.bundle.js

File ESM tự chứa (không còn import từ CDN nào khác) gộp `@codemirror/view` + `@codemirror/state` +
`@codemirror/commands` + `@codemirror/lang-sql` + `@codemirror/lang-javascript` +
`@codemirror/autocomplete` + `codemirror` (basicSetup) — dùng bởi `public/index.html`. `lang-javascript`
làm nền tô cú pháp cho editor Mongo (query dạng `db.collection.find({...})` hợp cú pháp JS object
literal); `autocompletion`/`CompletionContext` export riêng để `index.html` tự viết 1 completion
source gợi ý tên field thật lấy từ `GET /sql/autocomplete-schema` (xem mục "Mongo field-name
autocomplete" trong `k8sctl/CLAUDE.md`) — không có sẵn 1 "Mongo shell mode" tương đương
`@codemirror/lang-sql` nên phần completion source này là code tự viết, không phải cấu hình có sẵn.

## Vì sao không load qua CDN (esm.sh) như trước

Bug thật đã gặp nhiều lần khi load từng package riêng qua `https://esm.sh/...` (dù có pin version
hay không, kể cả dùng `?deps=` ép resolve chung): esm.sh trả về **nhiều instance khác nhau** của
cùng 1 package `@codemirror/state`/`@codemirror/view` cho các package phụ thuộc lẫn nhau — chính
CodeMirror tự phát hiện và báo lỗi thẳng ra console: `"multiple instances of @codemirror/state are
loaded, breaking instanceof checks"`. Hậu quả: crash khi click/gõ vào editor, hoặc bug tinh vi hơn
(gõ nhanh 2 ký tự bị nhân đôi ký tự đầu, vd "SE" → "SSE") do các extension (autocomplete,
transactionFilter viết-hoa tự động...) thấy state không nhất quán giữa các lần dispatch.

Fix triệt để: bundle mọi thứ thành 1 file duy nhất bằng esbuild — không còn multi-request CDN nào
nên không thể có instance trùng lặp.

## Cách build lại (khi cần nâng cấp version hoặc thêm package)

Không cần thêm dependency vào `k8sctl/package.json` — build 1 lần trong thư mục scratch riêng, chỉ
commit file output:

```bash
mkdir -p /tmp/cm-bundle && cd /tmp/cm-bundle
npm init -y >/dev/null
npm install --no-audit --no-fund esbuild codemirror @codemirror/lang-sql @codemirror/lang-javascript @codemirror/autocomplete @codemirror/commands @codemirror/state @codemirror/view

cat > entry.js <<'EOF'
export { EditorView, keymap } from "@codemirror/view";
export { EditorState, Compartment } from "@codemirror/state";
export { basicSetup } from "codemirror";
export { defaultKeymap, indentWithTab } from "@codemirror/commands";
export { sql, PostgreSQL } from "@codemirror/lang-sql";
export { javascript } from "@codemirror/lang-javascript";
export { autocompletion, CompletionContext } from "@codemirror/autocomplete";
EOF

npx esbuild entry.js --bundle --format=esm --outfile=codemirror.bundle.js --minify
cp codemirror.bundle.js <đường-dẫn-tới-k8sctl>/public/vendor/codemirror.bundle.js
```

Sau khi build lại — **verify bằng tay** trước khi commit (đúng bài học từ bug đã gặp, không tin
"không crash lúc load" là đủ):
1. Click/gõ vào ô SQL, gõ nhanh nhiều ký tự liên tiếp — không được nhân đôi ký tự.
2. Gõ `SELE` rồi bấm `Enter` khi menu autocomplete đang hiện "select" — nội dung phải thành
   `SELECT` (viết hoa đúng), không phải `select` (chữ thường, nghĩa là uppercase filter không áp
   dụng lên completion-accept).
3. Không có lỗi nào trong console trình duyệt khi thao tác trên.

## json-tree.js

File riêng (không phải ESM, không cần esbuild) — cây JSON thu gọn/mở rộng TỰ VIẾT cho kết quả query
MongoDB (khác `codemirror.bundle.js`, không cần bundle vì không có vấn đề multi-instance nào ở đây).
Gắn `window.renderJsonTree`, nạp qua `<script src="/vendor/json-tree.js"></script>` **trước**
`<script type="module">` chính trong `index.html` (script thường chạy ngay khi gặp, module bị defer
tới sau khi parse xong toàn trang — thứ tự này đảm bảo hàm đã sẵn sàng khi module cần dùng).

## Thêm export mới

Nếu sau này cần thêm API khác từ CodeMirror (vd `@codemirror/search`, `@codemirror/lint`) — thêm
dòng `export { ... } from "..."` vào `entry.js`, cài thêm package tương ứng, build lại như trên.
Không tự ý quay lại import CDN riêng lẻ trong `public/index.html` — sẽ tái phát đúng bug đã ghi ở
trên.
