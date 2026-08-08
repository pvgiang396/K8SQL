class AppError extends Error {
  constructor(message, statusCode = 400, metadata = {}) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.metadata = metadata;
  }
}

function extractK8sError(err) {
  if (!err) {
    return {};
  }

  const statusCode = err.statusCode || err.code || err.response?.statusCode || err.response?.status;
  const message = err.body?.message || err.response?.body?.message || err.message;
  return { statusCode, message };
}

function errorMiddleware(err, _req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      message: err.message,
      ...(Object.keys(err.metadata).length ? { metadata: err.metadata } : {})
    });
  }

  const parsed = extractK8sError(err);
  return res.status(Number(parsed.statusCode) || 500).json({
    success: false,
    message: parsed.message || "Unexpected server error."
  });
}

module.exports = {
  AppError,
  extractK8sError,
  errorMiddleware
};
