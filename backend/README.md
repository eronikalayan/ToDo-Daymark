# Daymark REST API

A small, layered Express API for the Daymark to-do app. It uses Prisma with SQLite for local development, Zod for request validation, bcrypt for password hashing, and JWTs in `HttpOnly` cookies for browser sessions.

## Project layout

```text
backend/
├── prisma/                 # Prisma schema and checked-in SQL migrations
├── src/
│   ├── config/             # Environment parsing and Prisma client
│   ├── controllers/        # HTTP request/response handling
│   ├── middleware/         # Authentication, validation, and error handling
│   ├── routes/             # Endpoint-to-controller mapping
│   ├── schemas/            # Zod request schemas
│   ├── services/           # Business logic and database access
│   ├── utils/              # Shared helpers and safe user serialization
│   ├── app.js              # Express app (safe to import in tests)
│   └── server.js           # Database connection and HTTP lifecycle
├── test/
│   ├── helpers/            # Test DB guard, fixtures, HTTP client
│   ├── unit/               # Pure-function and schema tests (no database)
│   ├── fixtures/           # Child-process fixtures (e.g. a stubbed email provider)
│   └── *.test.js           # app / api-routing / auth / tasks / social suites
├── scripts/                # Isolated test-database runner, backup/restore, migration rehearsal
├── eslint.config.js
└── .env.example
```

## Run locally

Requires Node.js 20.19 LTS or later.

1. Open a terminal in `backend/`.
2. Copy `.env.example` to `.env` and set `JWT_SECRET` to a private random value of at least 32 characters. Keep `.env` out of source control.
3. Install packages with `npm install`.
4. Generate the Prisma client with `npm run db:generate`.
5. Create/apply the local SQLite migration with `npm run db:migrate`.
6. Start with `npm start` (or `npm run dev` for watch mode). With `SERVE_FRONTEND=true`, open `http://localhost:4000`; the server serves only the allowlisted frontend files and `/api`.
7. Check `GET http://localhost:4000/api/health`.

Set `CORS_ORIGIN` to exact frontend origin(s), comma-separated. The development example allows the single-origin server and common VS Code Live Server origins. A page opened as `file://` does not have a usable web origin; serve it over localhost.

### Node version and the native SQLite build

The required Node version is pinned in `.nvmrc` at the repository root; run `nvm use` (or the equivalent for your version manager) before installing. CI reads the same file, so local and CI environments cannot drift apart.

`better-sqlite3` is a native addon. Its install step tries a prebuilt binary first and compiles from source when none matches, which requires a C/C++ toolchain (`make`, a C++ compiler, and Python 3; on macOS the Xcode Command Line Tools provide these).

The compiled binary is tied to the Node ABI it was built against, so **after switching Node versions you must rebuild it**:

```sh
npm rebuild better-sqlite3    # or simply: rm -rf node_modules && npm ci
```

Skipping this produces the misleading error `Could not locate the bindings file`, and any route that touches the database then fails with HTTP 500 — including `GET /api/health`.

### Linting

`npm run lint` runs ESLint over the backend source. The configuration in `eslint.config.js` is deliberately limited to correctness rules, so it passes on the existing code without reformatting it. Run it before pushing; CI runs it too.

The SQLite file is created at `prisma/dev.db`. To apply checked-in migrations in a deployed environment, use `npm run db:deploy`.

## Authentication

The API sets a signed JWT in an `HttpOnly` cookie named by `COOKIE_NAME`; the token is not included in JSON responses. Browser clients should use `fetch(url, { credentials: 'include' })`. The server stores session IDs and revokes the active session on logout. The API accepts cookie sessions only.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/auth/register` | Create an account and start a session (`name`, `email`, `password`) |
| POST | `/api/auth/login` | Start a session (`email`, `password`) |
| GET | `/api/auth/me` | Get the signed-in user |
| GET | `/api/auth/session` | Bootstrap the browser session (`user` is `null` when signed out) |
| POST | `/api/auth/logout` | Clear the session cookie |
| GET | `/api/auth/verify-email?token=...` | Consume a one-time email verification link |
| POST | `/api/auth/resend-verification` | Request another verification link (generic response) |
| POST | `/api/auth/password-reset/request` | Request a one-time password-reset link (generic response) |
| POST | `/api/auth/password-reset/confirm` | Set a new password with `{ "token": "...", "password": "..." }` |
| DELETE | `/api/auth/me` | Delete the signed-in user and associated data (requires password confirmation) |

Register and login are rate-limited. Login failures intentionally share the same response for unknown emails and incorrect passwords. User responses use an allowlist and never include password hashes.

In development, verification links are printed to the backend console. Production requires `APP_BASE_URL`, `EMAIL_PROVIDER_URL`, `EMAIL_PROVIDER_TOKEN`, and `EMAIL_FROM` (a plain email address), and registration sends a verification email before allowing login. The provider endpoint must accept the JSON payload in `src/services/email.service.js`; adapt that adapter to your transactional email provider. Never expose its token to the browser.

## Tasks

All task routes require a valid session cookie. `Authorization: Bearer <token>` is **not** supported: `src/middleware/authenticate.js` reads the session JWT only from the `HttpOnly` cookie, so the identical token offered as a bearer header is rejected with `401 UNAUTHENTICATED`. Adding bearer support would mean accepting a second credential channel that the CSRF origin check does not cover, so it is a deliberate omission rather than a gap.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/tasks` | Create a task |
| GET | `/api/tasks` | List tasks with filters and pagination |
| GET | `/api/tasks/:id` | Read one owned task |
| PATCH | `/api/tasks/:id` | Update title, description, due date, priority, or completion |
| PATCH | `/api/tasks/:id/toggle` | Toggle completion and `completedAt` |
| DELETE | `/api/tasks/:id` | Delete a task |

Creation may include `assignedToId`. It must identify an accepted friend. The task is owned by and visible only to the recipient; `createdById` records the sender. Sender access to the recipient's task returns 404. Assignment creates a chat notification.

Task list query parameters: `completed=true|false`, `priority=low|medium|high`, `search=term`, `dueBefore=ISO-date`, `dueAfter=ISO-date`, `sortBy=createdAt|dueDate|priority`, `order=asc|desc`, `page=1`, and `limit=20` (maximum 100). `dueBefore` includes the given date when passed as `YYYY-MM-DD`; `dueAfter` includes that day as well.

Successful responses use a `{ "data": ... }` envelope; task-list responses also include `{ "meta": { "pagination": ... } }`. Errors use `{ "error": { "message": "...", "code": "..." } }` and validation errors can include `details`.

Task access is always scoped by both task ID and authenticated user ID. Requests for another user's task deliberately return 404.

## Friends and chat

All social endpoints require authentication. Chat and task assignment are only allowed between accepted friends.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/friends` | List friends and incoming/outgoing requests |
| POST | `/api/friends/requests` | Send a request using `{ "email": "..." }` (auto-accepts a reciprocal pending request) |
| PATCH | `/api/friends/requests/:id` | Accept or decline using `{ "action": "accept" | "decline" }` |
| DELETE | `/api/friends/:friendId` | Remove an accepted friend |
| GET | `/api/friends/:friendId/messages?page=1&limit=50` | List a friend conversation |
| POST | `/api/friends/:friendId/messages` | Send `{ "body": "..." }` (maximum 500 characters) |

## Route organization

`src/routes/api.routes.js` is mounted at `/api` and mounts one router per resource
on an **explicit prefix**:

| Prefix | Router | Authentication |
| --- | --- | --- |
| `/api/health` | defined inline | public |
| `/api/auth` | `auth.routes.js` | per route — public except `GET`/`DELETE /me`; `GET /session` uses `optionalAuthenticate` and answers either way |
| `/api/tasks` | `task.routes.js` | per route — every route requires a session |
| `/api/friends` | `social.routes.js` | per route — every route requires a session |

Two conventions keep this correct, and both are asserted by
`test/api-routing.test.js`:

**No router is mounted at `/`, and `authenticate` is never attached with a
path-less `router.use`.** Express matches a path-less `use` against *every* path
under the mount point, including paths that have no route at all. A router mounted
at `/` therefore becomes the catch-all for the entire API, and a router-level
`authenticate` rejects unknown URLs as `401 UNAUTHENTICATED` before the not-found
handler can run. That combination was audit finding BE-004: it made `notFound`
unreachable for the whole API, and because the bundled frontend signs the user out
on any unexpected `401`, a single mistyped URL ended the session. Attaching
`authenticate` per route means authentication guards the routes it owns rather than
every string that starts with the mount path.

**Literal paths are registered before parameterized ones** — `/requests` before
`/:friendId`, `/:id/toggle` before `/:id` — so the more specific route wins.

Unknown paths under `/api` fall through to the `notFound` middleware and receive
`404` with the standard error envelope and code `NOT_FOUND`. This is scoped to the
API rather than left to the application-level fallback so that adding a
single-page-app catch-all to `app.js` later cannot start answering
`/api/unknown` with HTML.

A `404` from a controller and a `404` from the router are distinguished by code:
`TASK_NOT_FOUND` or `FRIEND_NOT_FOUND` means the route matched and the record did
not exist; `NOT_FOUND` means no such endpoint.

## Security and extending the API

- Helmet, a 16 KB JSON body limit, exact-origin credentialed CORS, request logging, Zod validation, and central error mapping are enabled.
- Passwords are bcrypt-hashed (12 rounds); hashes are only used inside the auth service.
- SQLite is configured behind Prisma. For PostgreSQL, change the Prisma datasource provider/URL, add the PostgreSQL driver configuration required by the chosen Prisma version, and create a new migration rather than editing an already-applied migration.
- User, task, friendship, verification-token, and chat data are separate models, with task ownership enforced in services. Workspace memberships and roles can be added without weakening task ownership checks.
- The task schema has nullable description/due date and lifecycle timestamps to support later reminders, labels, or activity history. Those features are not included here.

## Tests

| Command | Suite | Expected result |
| --- | --- | --- |
| `npm test` | Stable suite — unit, guard, app, api-routing, auth, tasks, social | Must pass. This is what CI gates on. |
| `npm run test:defects` | Known-defect suite — reproductions of defects that are known but not yet fixed | **Currently empty.** Every audited finding (BE-001…BE-004) is fixed, and its reproduction tests were promoted into the stable suite. Not run by CI. |
| `npm run test:all` | Both, reported separately | Stable green; nothing to report for defects. |

Reproduction tests are promoted rather than deleted when a defect is fixed, so the
behaviour each one describes stays guarded:

| Finding | Task | Guarded by |
| --- | --- | --- |
| BE-001 | REF-010 | `test/task-creator-lifecycle.test.js` |
| BE-002 | REF-011 | `test/auth-email-reliability.test.js` |
| BE-003 | REF-012 | `test/auth-rate-limit*.test.js` |
| BE-004 | REF-013 / REF-014 | `test/api-routing.test.js` |

The runner applies migrations to a separate `prisma/test.db` and never touches the
development database. Test files execute one at a time (`--test-concurrency=1`):
SQLite permits a single writer, and parallel files otherwise collide on the
interactive transaction in `toggleTask`, producing intermittent 500s.

### Never run a test file directly

`node --test test/<file>.test.js` inherits `.env` and would bind **`prisma/dev.db`**.
Every suite loads `test/helpers/guard.js` first, which refuses to run unless
`NODE_ENV=test` and `DATABASE_URL` points at a recognised test database, so such a
run now aborts before any connection is opened. `test/guard-contract.test.js`
asserts that every test file keeps that guard as its first `require`.

Fixtures come from `test/helpers/factories.js` and are created through Prisma
rather than through `POST /api/auth/register`, which is capped at 5 requests per
hour per IP in every environment. Registration itself is still covered by HTTP
tests in `test/auth.test.js`.

> `npm run db:migrate` runs `prisma migrate dev`, which may **reset** the database
> when it detects drift. It is for local development only; CI and any non-development
> environment must use `npm run db:deploy`.
