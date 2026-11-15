const { z } = require('zod');

const friendParams = z.object({ friendId: z.string().uuid() }).strict();
const requestParams = z.object({ id: z.string().uuid() }).strict();
const requestBody = z.object({
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase())
}).strict();
const requestDecisionBody = z.object({ action: z.enum(['accept', 'decline']) }).strict();
const messageBody = z.object({ body: z.string().trim().min(1).max(500) }).strict();
const messagesQuery = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50)
}).strict();

module.exports = { friendParams, requestParams, requestBody, requestDecisionBody, messageBody, messagesQuery };
