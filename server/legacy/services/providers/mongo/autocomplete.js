"use strict";

// Autocomplete field thật cho Mongo (quyết định đã chốt với user — đầu tư sâu hơn cú pháp JS suông):
// sample N document mỗi collection của database MẶC ĐỊNH (lấy từ connection string, xem
// query.js::defaultDbName) để suy ra tên field/type — hình dạng {collections:[{name, fields}]} song
// song với Postgres's {tables:[{schema, name, columns}]}, cùng dùng qua endpoint
// GET /sql/autocomplete-schema. Giới hạn đã biết: chỉ bao phủ database mặc định (không quét mọi
// database trong connection để tránh tốn quá nhiều round-trip khi chỉ mới chọn connection, chưa
// chọn database cụ thể trong cây) — ghi trong k8sctl/CLAUDE.md.
const { AppError } = require("../../../utils/error");
const { getDb } = require("./query");

const SAMPLE_SIZE = 50;

function bsonTypeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  if (typeof value === "object" && value?._bsontype === "ObjectID") return "objectId";
  return typeof value;
}

async function getFullSchema(env) {
  try {
    const db = await getDb(env);
    const collectionInfos = await db.listCollections({}, { nameOnly: true }).toArray();

    const collections = [];
    for (const info of collectionInfos) {
      const docs = await db.collection(info.name).find({}).limit(SAMPLE_SIZE).toArray();
      const fieldTypes = new Map();
      for (const doc of docs) {
        for (const [key, value] of Object.entries(doc)) {
          if (!fieldTypes.has(key)) {
            fieldTypes.set(key, bsonTypeName(value));
          }
        }
      }
      collections.push({
        name: info.name,
        fields: Array.from(fieldTypes.entries()).map(([name, type]) => ({ name, type }))
      });
    }

    return { collections };
  } catch (error) {
    throw error instanceof AppError ? error : new AppError(error.message, 400);
  }
}

module.exports = {
  getFullSchema
};
