function decodeSecretData(data) {
  const decoded = {};
  for (const [key, value] of Object.entries(data || {})) {
    try {
      decoded[key] = Buffer.from(value, "base64").toString("utf8");
    } catch {
      decoded[key] = null;
    }
  }
  return decoded;
}

module.exports = {
  decodeSecretData
};
