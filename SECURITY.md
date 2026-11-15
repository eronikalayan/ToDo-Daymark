# Security and deployment checklist

Daymark is not fully production-ready just because its application tests pass. Before accepting real users:

- Deploy behind HTTPS and set `NODE_ENV=production`.
- Set a generated, unique 64+ character `JWT_SECRET`, exact `CORS_ORIGIN`, production `APP_BASE_URL`, and `TRUST_PROXY_HOPS` to the actual trusted proxy count.
- Configure a transactional email provider for verification and password-reset links. Test delivery, link expiry, and one-time use.
- Use a durable production database with automated backups, retention, and a tested restore procedure. SQLite is the local-development adapter; for multi-instance deployment use managed PostgreSQL and a reviewed Prisma adapter/migration.
- Review privacy/data-retention obligations and publish a privacy notice and support contact. Account deletion cascades tasks, friendships, messages, sessions, and verification/reset records.
- Run `npm audit`, backend tests, CORS/CSRF checks, auth/session revocation checks, and user-to-user authorization tests on every release.
- Keep `.env`, provider credentials, and database files out of source control. Rotate secrets if there is any chance they were exposed.

The password-reset and verification email adapter is provider-specific. It expects a JSON API that accepts `from`, `to`, `subject`, and `text`; verify that contract and use a reputable provider before public launch.
