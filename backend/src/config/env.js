const path = require('node:path');
const dotenv = require('dotenv');
const { z } = require('zod');

// Always load the backend's own .env, even if the command is run from another folder.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL_SECONDS: z.coerce.number().int().min(60).max(60 * 60 * 24 * 30).default(60 * 60 * 24 * 7),
  COOKIE_NAME: z.string().min(1).default('daymark_session'),
  COOKIE_SAME_SITE: z.enum(['strict', 'lax', 'none']).default('lax'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  SERVE_FRONTEND: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  APP_BASE_URL: z.string().url().default('http://localhost:5500'),
  EMAIL_PROVIDER_URL: z.string().url().optional(),
  EMAIL_PROVIDER_TOKEN: z.string().optional(),
  EMAIL_FROM: z.string().email().optional(),
  CORS_ORIGIN: z.string().default('http://localhost:4000,http://127.0.0.1:4000,http://localhost:5500,http://127.0.0.1:5500')
}).superRefine((config, context) => {
  if (config.NODE_ENV === 'production') {
    if (config.JWT_SECRET.length < 64 || /replace-this|change-me|example|development-only/i.test(config.JWT_SECRET)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['JWT_SECRET'], message: 'Production requires a unique random JWT_SECRET of at least 64 characters.' });
    }
    if (!config.CORS_ORIGIN.trim()) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['CORS_ORIGIN'], message: 'Production requires explicit frontend origins.' });
    }
    if (!config.APP_BASE_URL.startsWith('https://')) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['APP_BASE_URL'], message: 'Production APP_BASE_URL must use HTTPS.' });
    }
    if (!config.EMAIL_PROVIDER_URL || !config.EMAIL_PROVIDER_TOKEN || !config.EMAIL_FROM) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['EMAIL_PROVIDER_URL'], message: 'Production requires a configured verification email provider.' });
    }
    if (config.EMAIL_PROVIDER_URL && !config.EMAIL_PROVIDER_URL.startsWith('https://')) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['EMAIL_PROVIDER_URL'], message: 'Email provider URL must use HTTPS.' });
    }
    // Every IP-keyed rate limit depends on request.ip being the real client. If
    // TRUST_PROXY_HOPS is left to its default behind a proxy, request.ip is the
    // proxy and all clients share one bucket, so one attacker locks everyone out.
    // Set too high, forged X-Forwarded-For entries are trusted and IP limits are
    // bypassed outright. Production must therefore state the value deliberately —
    // including "0" for a directly exposed server.
    if (process.env.TRUST_PROXY_HOPS === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TRUST_PROXY_HOPS'],
        message: 'Production requires TRUST_PROXY_HOPS to be set explicitly: the number of trusted proxies in front of this server, or 0 if it is directly exposed. Rate limiting is only as accurate as this value.'
      });
    }
  }
  if (config.COOKIE_SAME_SITE === 'none' && config.NODE_ENV !== 'production') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['COOKIE_SAME_SITE'], message: 'SameSite=None requires HTTPS in production.' });
  }
});

const result = envSchema.safeParse(process.env);
if (!result.success) {
  const problems = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n');
  throw new Error(`Invalid backend environment configuration:\n${problems}`);
}

const env = {
  ...result.data,
  CORS_ORIGINS: [...new Set([
    ...result.data.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean),
    new URL(result.data.APP_BASE_URL).origin
  ])]
};

module.exports = { env };
