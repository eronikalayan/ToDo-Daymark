'use strict';

/**
 * API routing and authentication boundaries — the permanent guard for BE-004.
 *
 * THE DEFECT (fixed by REF-013 / REF-014 in Stage 6)
 * --------------------------------------------------
 * Unknown /api routes answered 401 UNAUTHENTICATED instead of 404 NOT_FOUND.
 * There were two independent causes, and fixing either one alone was not enough:
 *
 *   1. src/routes/api.routes.js mounted the social router with `router.use('/', ...)`.
 *      A path-less mount makes a resource router the catch-all for the entire
 *      mount point, so every unmatched /api URL was handed to it.
 *   2. social.routes.js and task.routes.js both began with `router.use(authenticate)`.
 *      A path-less `use` matches every path under the mount — including paths that
 *      have no route at all — so an unmatched URL was rejected as unauthenticated
 *      before `notFound` could ever run.
 *
 * The practical damage was in the browser: the bundled frontend signs the user out
 * on any unexpected 401 (`app.js:75`), so one mistyped URL silently ended the
 * session.
 *
 * This file was written in Stage 2 as a known-defect suite that was expected to
 * fail. The defect is fixed, so it now lives in the stable suite as a regression
 * guard. Every original assertion is preserved unchanged; the endpoint matrix and
 * route-ordering sections were added in Stage 6, because "unknown paths are 404"
 * is only half the contract — the other half is that all 23 real endpoints stayed
 * reachable and still require exactly the authentication they required before.
 */
require('./helpers/guard'); // MUST be first — see helpers/guard.js

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../src/app');
const F = require('./helpers/factories');
const { asUser, anonymous, request } = require('./helpers/client');

const client = anonymous(app);

after(async () => {
  await F.cleanup();
  await F.disconnect();
});

describe('BE-004: an unknown API route must be 404, not 401', () => {
  const unknownPaths = [
    '/api/does-not-exist',
    '/api/auth/does-not-exist',
    '/api/friends/not-a-real-sub-route/extra',
    '/api/'
  ];

  for (const unknownPath of unknownPaths) {
    test(`GET ${unknownPath} returns 404 when unauthenticated`, async () => {
      const response = await client.get(unknownPath);
      assert.notEqual(
        response.status,
        401,
        `DEFECT: ${unknownPath} does not exist, but answers 401 — the frontend reads that as an expired session`
      );
      assert.equal(response.status, 404);
      assert.equal(response.body.error.code, 'NOT_FOUND');
    });
  }

  test('the same URL does not change status depending on whether a session exists', async () => {
    const user = await F.createSignedInUser();
    const anonymousResponse = await client.get('/api/does-not-exist');
    const authenticatedResponse = await asUser(app, user).get('/api/does-not-exist');

    assert.equal(
      anonymousResponse.status,
      authenticatedResponse.status,
      'DEFECT: an unknown route answers 401 to anonymous callers and 404 to authenticated ones'
    );
  });

  // Controls: routing must not be "fixed" by weakening authentication. These
  // pass today and must keep passing after REF-013/REF-014.
  describe('CONTROL (passes today): real routes still require authentication', () => {
    const protectedRoutes = ['/api/tasks', '/api/auth/me', '/api/friends'];

    for (const route of protectedRoutes) {
      test(`GET ${route} still returns 401 without a session`, async () => {
        const response = await client.get(route);
        assert.equal(response.status, 401);
        assert.equal(response.body.error.code, 'UNAUTHENTICATED');
      });
    }

    test('an authenticated caller still reaches a real route', async () => {
      const user = await F.createSignedInUser();
      assert.equal((await asUser(app, user).get('/api/tasks')).status, 200);
    });

    test('an unknown route outside /api is already 404', async () => {
      const response = await client.get('/totally-unknown');
      assert.equal(response.status, 404);
      assert.equal(response.body.error.code, 'NOT_FOUND');
    });

    test('health remains reachable without a session', async () => {
      assert.equal((await client.get('/api/health')).status, 200);
    });
  });
});

// ---------------------------------------------------------------------------
// Added in Stage 6 (REF-013). The sections above prove unknown paths are 404;
// these prove the fix did not cost us an endpoint or an auth boundary.
// ---------------------------------------------------------------------------

/**
 * The full API surface: method, path, and whether a session is required.
 *
 * This is the 23-endpoint inventory from docs/audit/BACKEND_CODE_REVIEW.md §4.
 * A random UUID is used for path parameters — these requests are meant to reach
 * their handler, not to succeed.
 */
const UUID = '11111111-2222-4333-8444-555555555555';
const API_SURFACE = [
  ['GET', '/api/health', false],
  ['POST', '/api/auth/register', false],
  ['POST', '/api/auth/login', false],
  ['GET', '/api/auth/session', false],
  ['GET', '/api/auth/verify-email', false],
  ['POST', '/api/auth/resend-verification', false],
  ['POST', '/api/auth/password-reset/request', false],
  ['POST', '/api/auth/password-reset/confirm', false],
  ['POST', '/api/auth/logout', false],
  ['GET', '/api/auth/me', true],
  ['DELETE', '/api/auth/me', true],
  ['POST', '/api/tasks', true],
  ['GET', '/api/tasks', true],
  ['GET', `/api/tasks/${UUID}`, true],
  ['PATCH', `/api/tasks/${UUID}/toggle`, true],
  ['PATCH', `/api/tasks/${UUID}`, true],
  ['DELETE', `/api/tasks/${UUID}`, true],
  ['GET', '/api/friends', true],
  ['POST', '/api/friends/requests', true],
  ['PATCH', `/api/friends/requests/${UUID}`, true],
  ['DELETE', `/api/friends/${UUID}`, true],
  ['GET', `/api/friends/${UUID}/messages`, true],
  ['POST', `/api/friends/${UUID}/messages`, true]
];

describe('REF-013: every endpoint survived the remount', () => {
  test('the inventory under test is the documented 23 endpoints', () => {
    assert.equal(API_SURFACE.length, 23, 'the audited surface is 23 endpoints; update the docs with the code');
  });

  // The ANONYMOUS response is the clean routing signal. A protected route
  // answers 401 before its handler runs, so it cannot produce a domain 404 that
  // would be confused with a routing one.
  for (const [method, path, requiresSession] of API_SURFACE) {
    const label = `${method} ${path.replace(UUID, ':id')}`;

    test(`${label} is still routed`, async () => {
      const response = await client.request(method, path);
      assert.notEqual(
        response.status,
        404,
        `${label} is no longer reachable — the remount dropped an endpoint`
      );
    });

    test(`${label} ${requiresSession ? 'requires' : 'does not require'} a session`, async () => {
      const response = await client.request(method, path);
      if (requiresSession) {
        assert.equal(response.status, 401, `${label} must still reject anonymous callers`);
        assert.equal(response.body.error.code, 'UNAUTHENTICATED');
      } else {
        assert.notEqual(response.status, 401, `${label} is public and must not demand a session`);
      }
    });
  }
});

describe('REF-013: a 404 from a handler is not a 404 from the router', () => {
  // Both are 404, and conflating them would hide a dropped route. The error code
  // is what separates "no such task" from "no such endpoint".
  test('a missing task is TASK_NOT_FOUND, not NOT_FOUND', async () => {
    const user = await F.createSignedInUser();
    const response = await asUser(app, user).get(`/api/tasks/${UUID}`);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'TASK_NOT_FOUND', 'the task route must reach its controller');
  });

  test('a missing friend is FRIEND_NOT_FOUND, not NOT_FOUND', async () => {
    const user = await F.createSignedInUser();
    const response = await asUser(app, user).get(`/api/friends/${UUID}/messages`);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'FRIEND_NOT_FOUND', 'the messages route must reach its controller');
  });

  test('an unknown endpoint is NOT_FOUND even for an authenticated caller', async () => {
    const user = await F.createSignedInUser();
    const response = await asUser(app, user).get('/api/tasks/also/not/a/route');
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOT_FOUND');
  });
});

describe('REF-013: specific paths still win over parameterized ones', () => {
  // /requests must not be swallowed by /:friendId, and /:id/toggle must not be
  // swallowed by /:id. Route order is the only thing keeping these apart, so it
  // is asserted rather than assumed.
  test('POST /api/friends/requests is the request route, not a friend id', async () => {
    const user = await F.createSignedInUser();
    const response = await asUser(app, user).post('/api/friends/requests', {});
    // Reaching the body validator proves the literal route matched; had it been
    // read as /:friendId, the method would not be routed at all.
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  test('PATCH /api/friends/requests/:id decides a request', async () => {
    const user = await F.createSignedInUser();
    const response = await asUser(app, user).patch(`/api/friends/requests/${UUID}`, {});
    assert.notEqual(response.status, 404, 'the decision route must stay reachable');
    assert.equal(response.status, 422, 'an empty decision body is a validation error');
  });

  test('PATCH /api/tasks/:id/toggle is the toggle route, not an update', async () => {
    const user = await F.createSignedInUser();
    const response = await asUser(app, user).patch(`/api/tasks/${UUID}/toggle`, {});
    // The toggle route takes no body, so a missing task is the furthest this can
    // get. An update route would have answered 422 for the empty body instead.
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'TASK_NOT_FOUND');
  });
});

describe('REF-014: the API not-found handler is reachable in every shape', () => {
  const methods = ['GET', 'POST', 'PATCH', 'DELETE'];

  for (const method of methods) {
    test(`${method} on an unknown API path is 404 NOT_FOUND`, async () => {
      const response = await client.request(method, '/api/nothing-here');
      assert.equal(response.status, 404, 'the not-found handler must not be method-specific');
      assert.equal(response.body.error.code, 'NOT_FOUND');
    });
  }

  test('an unsupported method on a real path is not answered as 401', async () => {
    // PUT is not defined on /api/tasks. It has no route, so it must fall through
    // to the not-found handler rather than being rejected as unauthenticated.
    const response = await client.request('PUT', '/api/tasks');
    assert.notEqual(response.status, 401, 'an unrouted method must not look like an expired session');
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOT_FOUND');
  });

  test('the not-found response uses the project error envelope', async () => {
    const response = await client.get('/api/still-nothing');
    assert.equal(response.status, 404);
    assert.equal(typeof response.body.error.message, 'string');
    assert.deepEqual(Object.keys(response.body.error).sort(), ['code', 'message']);
    assert.equal(response.body.data, undefined, 'an error response carries no data envelope');
  });

  test('a deep unknown path under a real prefix is still 404', async () => {
    for (const path of ['/api/auth/nope', '/api/tasks/a/b/c', '/api/friends/x/y/z']) {
      const response = await client.get(path);
      assert.equal(response.status, 404, `${path} must be 404`);
      assert.equal(response.body.error.code, 'NOT_FOUND', `${path} must be NOT_FOUND`);
    }
  });
});

describe('BE-015 / REF-016: the documented credential channel is the only one', () => {
  // README.md states that the session cookie is the only accepted credential.
  // A documented security boundary is worth an assertion, because the failure
  // mode of getting this wrong is a second credential channel that the CSRF
  // origin check does not cover.
  test('the same JWT is accepted in the cookie and rejected as a bearer token', async () => {
    const user = await F.createSignedInUser();
    const rawToken = String(user.cookie).split('=')[1].split(';')[0];

    assert.equal((await asUser(app, user).get('/api/tasks')).status, 200, 'the cookie must work');

    const viaBearer = await request(app).get('/api/tasks').set('Authorization', `Bearer ${rawToken}`);
    assert.equal(viaBearer.status, 401, 'bearer tokens are deliberately unsupported; see README.md');
    assert.equal(viaBearer.body.error.code, 'UNAUTHENTICATED');
  });
});
