const taskService = require('../services/task.service');

async function createTask(request, response) {
  const task = await taskService.createTask(request.user.id, request.validated.body);
  response.status(201).json({ data: { task } });
}

async function listTasks(request, response) {
  const result = await taskService.listTasks(request.user.id, request.validated.query);
  response.status(200).json({ data: { tasks: result.tasks }, meta: { pagination: result.pagination } });
}

async function getTask(request, response) {
  const task = await taskService.getTask(request.user.id, request.validated.params.id);
  response.status(200).json({ data: { task } });
}

async function updateTask(request, response) {
  const task = await taskService.updateTask(request.user.id, request.validated.params.id, request.validated.body);
  response.status(200).json({ data: { task } });
}

async function toggleTask(request, response) {
  const task = await taskService.toggleTask(request.user.id, request.validated.params.id);
  response.status(200).json({ data: { task } });
}

async function deleteTask(request, response) {
  await taskService.deleteTask(request.user.id, request.validated.params.id);
  response.status(204).end();
}

module.exports = { createTask, listTasks, getTask, updateTask, toggleTask, deleteTask };
