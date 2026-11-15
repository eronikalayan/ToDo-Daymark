# Daymark

Daymark is a vanilla HTML/CSS/JavaScript frontend backed by the Express REST API in `backend/`.

## Start the application

Requirements: Node.js 20.19 or newer.

1. In a terminal at the project root, run `npm install` once for the root convenience scripts.
2. Run `npm --prefix backend install` to install API dependencies.
3. Configure `backend/.env` from `backend/.env.example`. The development SQLite URL and a local-only development key are already set in the provided local file; never reuse them in production.
4. Run `npm run db:generate` and `npm run db:migrate` from the project root.
5. Start the API using `npm start` from the project root (or `npm run dev` for watch mode).
6. Open `http://localhost:4000` in your browser. The backend serves the frontend on the same origin when `SERVE_FRONTEND=true`.
7. Alternatively, serve the project root with VS Code Live Server (usually port 5500); its origin must be listed under `CORS_ORIGIN`. Never open the page using `file://`.

The frontend uses same-origin `/api` when opened from the backend server, and `http://localhost:4000/api` when served from localhost on another port. To override this, set `window.DAYMARK_API_BASE_URL` before loading `app.js`, or change the `api-base-url` meta tag.

## Backend

See [backend/README.md](backend/README.md) for API routes, migrations, tests, and backend configuration. Run tests with `npm test` from the project root.

Production requires HTTPS, a unique secret, exact frontend CORS origins, a real transactional email provider for verification and password recovery, and persistent database storage with backups. SQLite is suitable for local development; evaluate PostgreSQL for multi-instance production deployments.

## Account and social features

Registration, login, logout, email verification, password recovery, personal tasks, friend requests, recipient-owned task assignment, chat, and account deletion use the backend. For production, configure and test the email provider, use HTTPS and a strong secret, and verify database backups before accepting users.

Accounts from the earlier browser-only prototype were stored locally and are not migrated to SQLite; create a new account on the server-backed app.
