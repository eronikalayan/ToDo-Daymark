const express = require('express');
const taskController = require('../controllers/task.controller');
const { authenticate } = require('../middleware/authenticate');
const { validate } = require('../middleware/validate');
const { createTaskSchema, updateTaskSchema, listTasksSchema, idParams } = require('../schemas/task.schemas');
const { asyncHandler } = require('../utils/async-handler');

const router = express.Router();

// `authenticate` is attached PER ROUTE, not as a router-level `use`.
//
// A path-less `router.use(authenticate)` matches every path under the mount,
// including paths with no route, so an anonymous request to /api/tasks/a/b/c was
// rejected as unauthenticated instead of reported as not found (BE-004).
// Authentication must guard the routes it owns, not every string beginning with
// the mount path.
//
// Every task route is protected; none is public. Listing them individually makes
// that visible on the line that defines each route, which is how auth.routes.js
// already reads.
router.post('/', authenticate, validate({ body: createTaskSchema }), asyncHandler(taskController.createTask));
router.get('/', authenticate, validate({ query: listTasksSchema }), asyncHandler(taskController.listTasks));
router.get('/:id', authenticate, validate({ params: idParams }), asyncHandler(taskController.getTask));
// /:id/toggle before /:id so the more specific PATCH path is matched first.
router.patch('/:id/toggle', authenticate, validate({ params: idParams }), asyncHandler(taskController.toggleTask));
router.patch('/:id', authenticate, validate({ params: idParams, body: updateTaskSchema }), asyncHandler(taskController.updateTask));
router.delete('/:id', authenticate, validate({ params: idParams }), asyncHandler(taskController.deleteTask));

module.exports = { taskRouter: router };
