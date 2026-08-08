// Shim thay thế package `optional-require` — CHỈ dùng khi build SEA (aliased trong build-sea.mjs).
//
// Vấn đề thật #1: `optional-require` cố tình dùng `eval("require")` để né các bundler tĩnh
// (comment gốc trong package: "avoid tripping bundlers like webpack"). Dưới Node SEA, MỌI
// require() — kể cả eval'd — bị `embedderRequire` chặn nếu không phải built-in module, ném
// `ERR_UNKNOWN_BUILTIN_MODULE` thay vì `MODULE_NOT_FOUND` mà `optional-require` biết bắt (xem
// `node_modules/optional-require/dist/index.js`, chỉ swallow `err.code === "MODULE_NOT_FOUND"`).
// `mongodb-legacy-driver` (mongodb@3.7, xem k8sctl/CLAUDE.md mục Mongo) gọi `retrieveEJSON()`
// NGAY LÚC LOAD MODULE (`lib/core/utils.js` → `lib/core/index.js` top-level), nên lỗi này luôn
// crash sidecar khi khởi động dưới SEA, kể cả khi không dùng driver legacy.
//
// Vấn đề thật #2: package `mongodb-extjson` (bản mới nhất được publish, 3.0.3) TỰ NÓ bị lỗi trên
// mọi bản Node hiện đại — không liên quan SEA — do bson@3.0.2 nó kéo theo có bug thật:
// `objectid.js` làm `const hostname = require('os').hostname` (thiếu dấu `()`, lấy reference hàm
// thay vì gọi hàm) rồi truyền thẳng function đó vào `Buffer.from()`, crash
// `ERR_INVALID_ARG_TYPE` ngay khi require — đã tự tay verify bằng `node -e "require('mongodb-extjson')"`
// trên Node 24 thuần, crash y hệt, xác nhận không phải lỗi do SEA/bundle gây ra. KHÔNG cài package
// này (`npm uninstall mongodb-extjson` đã chạy) — không có cách nào dùng được bản publish hiện tại.
//
// Fix: trả `undefined` cho cả 2 tên module optional mà `mongodb-legacy-driver` có thể xin —
// `retrieveEJSON()`/`retrieveKerberos()` (`lib/core/utils.js`) đã tự xử lý nhánh "không có module"
// một cách graceful (chỉ throw lỗi rõ ràng NẾU thật sự có code gọi EJSON.serialize()/... sau đó —
// codebase k8sctl/k8sql chủ động không dùng EJSON của driver legacy, tự viết `legacySerialize()`
// riêng trong `services/providers/mongo/query.js`, xem k8sctl/CLAUDE.md mục Mongo) — không cần
// require thật bất kỳ package nào ở đây, tránh luôn cả 2 vấn đề trên.
module.exports = function makeOptionalRequire() {
  return function requireOptional(_name) {
    return undefined;
  };
};
