const { z } = require('zod');

const emailSchema = z.string().trim().email().max(254).transform((email) => email.toLowerCase());
const passwordSchema = z.string().min(8, 'Password must be at least 8 characters').refine(
  (password) => Buffer.byteLength(password, 'utf8') <= 72,
  'Password must be 72 UTF-8 bytes or fewer when using bcrypt'
);

const registerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: emailSchema,
  password: passwordSchema
}).strict();

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256)
}).strict();

const deleteAccountSchema = z.object({
  password: passwordSchema
}).strict();

const verifyEmailQuerySchema = z.object({
  token: z.string().min(1).max(4096)
}).strict();
const resendVerificationSchema = z.object({ email: emailSchema }).strict();
const requestPasswordResetSchema = z.object({ email: emailSchema }).strict();
const resetPasswordSchema = z.object({ token: z.string().min(1).max(4096), password: passwordSchema }).strict();

module.exports = { registerSchema, loginSchema, deleteAccountSchema, verifyEmailQuerySchema, resendVerificationSchema, requestPasswordResetSchema, resetPasswordSchema };
