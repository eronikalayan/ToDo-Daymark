// Express 4 does not automatically forward rejected async handlers to error middleware.
const asyncHandler = (handler) => (request, response, next) => {
  Promise.resolve(handler(request, response, next)).catch(next);
};

module.exports = { asyncHandler };
