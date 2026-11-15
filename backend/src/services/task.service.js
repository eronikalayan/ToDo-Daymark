const { prisma } = require('../config/prisma');
const { AppError } = require('../utils/app-error');

const PRIORITY_ORDER = { low: 1, medium: 2, high: 3 };

function parseDate(value) {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : new Date(value);
}

function exclusiveDateEnd(value) {
  const date = parseDate(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return date;
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function buildListWhere(userId, filters) {
  const where = { userId };
  if (filters.completed !== undefined) where.completed = filters.completed;
  if (filters.priority) where.priority = filters.priority;
  if (filters.search) {
    where.OR = [
      { title: { contains: filters.search } },
      { description: { contains: filters.search } }
    ];
  }
  if (filters.dueAfter || filters.dueBefore) {
    where.dueDate = {};
    if (filters.dueAfter) where.dueDate.gte = parseDate(filters.dueAfter);
    if (filters.dueBefore) where.dueDate.lt = exclusiveDateEnd(filters.dueBefore);
  }
  return where;
}

async function createTask(userId, input) {
  const assignedToId = input.assignedToId || userId;
  if (assignedToId !== userId) {
    const friendship = await prisma.friendship.findFirst({
      where: {
        status: 'accepted',
        OR: [
          { requesterId: userId, addresseeId: assignedToId },
          { requesterId: assignedToId, addresseeId: userId }
        ]
      },
      select: { id: true }
    });
    if (!friendship) throw new AppError(404, 'Friend not found.', 'FRIEND_NOT_FOUND');
  }

  return prisma.$transaction(async (transaction) => {
    const task = await transaction.task.create({
      data: {
        userId: assignedToId,
        createdById: userId,
        title: input.title,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.dueDate !== undefined ? { dueDate: parseDate(input.dueDate) } : {}),
        priority: input.priority,
        priorityOrder: PRIORITY_ORDER[input.priority],
        sortOrder: input.sortOrder ?? 0
      }
    });
    if (assignedToId !== userId) {
      await transaction.chatMessage.create({
        data: {
          senderId: userId,
          recipientId: assignedToId,
          taskId: task.id,
          body: `Sent you a task: ${task.title}`
        }
      });
    }
    return task;
  });
}

async function listTasks(userId, filters) {
  const where = buildListWhere(userId, filters);
  const skip = (filters.page - 1) * filters.limit;
  const [tasks, total] = await prisma.$transaction([
    prisma.task.findMany({
      where,
      orderBy: filters.sortBy === 'priority'
        ? [{ priorityOrder: filters.order }, { createdAt: 'desc' }]
        : { [filters.sortBy]: filters.order },
      skip,
      take: filters.limit
    }),
    prisma.task.count({ where })
  ]);
  return {
    tasks,
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      pages: Math.ceil(total / filters.limit)
    }
  };
}

async function getTask(userId, id) {
  const task = await prisma.task.findFirst({ where: { id, userId } });
  if (!task) throw new AppError(404, 'Task not found.', 'TASK_NOT_FOUND');
  return task;
}

async function updateTask(userId, id, input) {
  const data = { ...input };
  delete data.assignedToId;
  if (input.dueDate !== undefined) data.dueDate = parseDate(input.dueDate);
  if (input.priority !== undefined) data.priorityOrder = PRIORITY_ORDER[input.priority];
  if (input.completed !== undefined) {
    const current = await prisma.task.findFirst({ where: { id, userId }, select: { completed: true } });
    if (!current) throw new AppError(404, 'Task not found.', 'TASK_NOT_FOUND');
    if (current.completed !== input.completed) data.completedAt = input.completed ? new Date() : null;
  }
  const result = await prisma.task.updateMany({ where: { id, userId }, data });
  if (result.count === 0) throw new AppError(404, 'Task not found.', 'TASK_NOT_FOUND');
  return getTask(userId, id);
}

async function toggleTask(userId, id) {
  return prisma.$transaction(async (transaction) => {
    const task = await transaction.task.findFirst({ where: { id, userId }, select: { completed: true } });
    if (!task) throw new AppError(404, 'Task not found.', 'TASK_NOT_FOUND');
    const completed = !task.completed;
    await transaction.task.updateMany({
      where: { id, userId },
      data: { completed, completedAt: completed ? new Date() : null }
    });
    return transaction.task.findFirst({ where: { id, userId } });
  });
}

async function deleteTask(userId, id) {
  const result = await prisma.task.deleteMany({ where: { id, userId } });
  if (result.count === 0) throw new AppError(404, 'Task not found.', 'TASK_NOT_FOUND');
}

module.exports = { createTask, listTasks, getTask, updateTask, toggleTask, deleteTask };
