'use strict';

// REF-007 — application-level behaviour that belongs to no single resource:
// health, body parsing, error envelope and routing. Preserves the health
// assertions from the original test/api.test.js.
require('./helpers/guard'); // MUST be first — see helpers/guard.js

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../src/app');
const F = require('./helpers/factories');
const { asUser, anonymous, request, TRUSTED_ORIGIN } = require('./helpers/client');

after(async () => {
  await F.cleanup();
  await F.disconnect();
});

describe('health', () => {
  test('reports the service and its database as reachable', async () => {
    const response = await anonymous(app).get('/api/health');
    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, 'ok');
    assert.equal(response.body.data.database, 'ok');
    assert.ok(response.body.data.timestamp);
  });
});

describe('request handling', () => {
  test('rejects malformed JSON with a structured 400', async () => {
    const user = await F.createSignedInUser();
    const response = await request(app)
      .post('/api/tasks')
      .set('Cookie', user.cookie)
      .set('Origin', TRUSTED_ORIGIN)
      .set('Content-Type', 'application/json')
      .send('{"title":');

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INVALID_JSON');
  });

  test('rejects a body over the 16 KB limit with 413', async () => {
    const user = await F.createSignedInUser();
    const response = await asUser(app, user).post('/api/tasks', {
      title: 'too big',
      description: 'y'.repeat(30_000)
    });

    assert.equal(response.status, 413);
    assert.equal(response.body.error.code, 'PAYLOAD_TOO_LARGE');
  });

  test('every error response uses the same envelope', async () => {
    const response = await anonymous(app).get('/api/tasks');
    assert.equal(response.status, 401);
    assert.deepEqual(Object.keys(response.body), ['error']);
    assert.deepEqual(Object.keys(response.body.error).sort(), ['code', 'message']);
  });

  test('validation failures carry a details array', async () => {
    const user = await F.createSignedInUser();
    const response = await asUser(app, user).get('/api/tasks?completed=maybe');
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(Array.isArray(response.body.error.details));
  });

  test('a request id is returned on every response', async () => {
    const response = await anonymous(app).get('/api/health');
    assert.match(response.headers['x-request-id'], /^[0-9a-f-]{36}$/);
  });
});

describe('routing', () => {
  test('an unknown route outside /api returns 404', async () => {
    const response = await anonymous(app).get('/totally-unknown');
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOT_FOUND');
  });

  test('an unknown /api route returns 404 for an authenticated caller', async () => {
    // The unauthenticated case is currently 401 instead of 404; that defect is
    // BE-004 and is covered by the known-defect suite, not asserted here.
    const user = await F.createSignedInUser();
    const response = await asUser(app, user).get('/api/does-not-exist');
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOT_FOUND');
  });
});
