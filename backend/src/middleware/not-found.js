const { AppError } = require('../utils/app-error');

function notFound(request, response, next) {
  next(new AppError(404, 'Route not found.', 'NOT_FOUND'));
}

module.exports = { notFound };
