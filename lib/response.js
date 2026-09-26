function sendSuccess(res, data = {}, message = 'Success', statusCode = 200) {
  return res.status(statusCode).json({ success: true, data, message });
}

function sendError(res, code = 'INTERNAL_ERROR', message = 'An unexpected error occurred.', statusCode = 500) {
  return res.status(statusCode).json({ success: false, error: { code, message } });
}

module.exports = { sendSuccess, sendError };
