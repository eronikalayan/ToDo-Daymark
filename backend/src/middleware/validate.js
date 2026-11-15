const { AppError } = require('../utils/app-error');

function validate(schemas) {
  return (request, response, next) => {
    const validated = {};
    for (const [part, schema] of Object.entries(schemas)) {
      const result = schema.safeParse(request[part]);
      if (!result.success) {
        return next(new AppError(422, 'Validation failed', 'VALIDATION_ERROR', result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message
        }))));
      }
      validated[part] = result.data;
    }
    request.validated = validated;
    next();
  };
}

module.exports = { validate };
