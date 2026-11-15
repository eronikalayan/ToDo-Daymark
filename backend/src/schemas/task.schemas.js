const { z } = require('zod');

const isValidDateValue = (value) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }
  return !Number.isNaN(Date.parse(value));
};

const dateValue = z.string().refine(isValidDateValue, 'Use a valid ISO date or date-time.').refine(
  (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) || /^\d{4}-\d{2}-\d{2}T/.test(value),
  'Use an ISO date or ISO date-time.'
);
const priority = z.enum(['low', 'medium', 'high']);
const idParams = z.object({ id: z.string().uuid() }).strict();

const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).nullable().optional(),
  dueDate: dateValue.nullable().optional(),
  priority: priority.default('medium'),
  assignedToId: z.string().uuid().optional(),
  sortOrder: z.number().int().min(0).max(1000000).optional()
}).strict();

const updateTaskSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  dueDate: dateValue.nullable().optional(),
  priority: priority.optional(),
  completed: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000000).optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update.');

const listTasksSchema = z.object({
  completed: z.preprocess((value) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }, z.boolean().optional()),
  priority: priority.optional(),
  search: z.string().trim().min(1).max(200).optional(),
  dueBefore: dateValue.optional(),
  dueAfter: dateValue.optional(),
  sortBy: z.enum(['createdAt', 'dueDate', 'priority']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
}).strict().refine(
  (filters) => !filters.dueAfter || !filters.dueBefore || Date.parse(filters.dueAfter) <= Date.parse(filters.dueBefore),
  { path: ['dueBefore'], message: 'dueBefore must be on or after dueAfter.' }
);

module.exports = { createTaskSchema, updateTaskSchema, listTasksSchema, idParams };
