'use strict';

// REF-006 — a thin supertest wrapper.
//
// It exists for one reason: the CSRF guard in src/app.js rejects any mutating
// request that carries a session cookie without an allowlisted `Origin` header.
// Forgetting that header produces a 403 CSRF_ORIGIN_DENIED that looks nothing
// like the behaviour under test, so the header is attached centrally.
//
// Nothing here weakens authentication: requests carry a real session cookie and
// pass through the application's own middleware unchanged.

require('./guard');

const request = require('supertest');
const { TRUSTED_ORIGIN } = require('./factories');

// Methods whose requests the CSRF guard inspects. GET is left alone so that an
// anonymous read is exercised exactly as the browser sends it.
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * One request by arbitrary method — used by the API routing suite, which has to
 * probe methods no endpoint defines (an unrouted PUT must be 404, not 401) and
 * to walk the whole endpoint inventory in a loop.
 *
 * A body is sent only when one is given, so a bodyless GET stays a bodyless GET.
 */
function sendRequest(app, method, path, body, cookie) {
  const upper = method.toUpperCase();
  let pending = request(app)[upper.toLowerCase()](path);
  if (cookie) pending = pending.set('Cookie', cookie);
  if (MUTATING_METHODS.has(upper)) pending = pending.set('Origin', TRUSTED_ORIGIN);
  return body === undefined ? pending : pending.send(body);
}

/** Requests authenticated as `user` (a result of createSignedInUser). */
function asUser(app, user) {
  const cookie = user.cookie;
  return {
    get: (path) => request(app).get(path).set('Cookie', cookie),
    post: (path, body) => request(app).post(path).set('Cookie', cookie).set('Origin', TRUSTED_ORIGIN).send(body),
    patch: (path, body) => request(app).patch(path).set('Cookie', cookie).set('Origin', TRUSTED_ORIGIN).send(body),
    delete: (path, body) => request(app).delete(path).set('Cookie', cookie).set('Origin', TRUSTED_ORIGIN).send(body),
    request: (method, path, body) => sendRequest(app, method, path, body, cookie)
  };
}

/** Requests with no session cookie. Origin is still sent, so a 401 is never masked by a 403. */
function anonymous(app) {
  return {
    get: (path) => request(app).get(path),
    post: (path, body) => request(app).post(path).set('Origin', TRUSTED_ORIGIN).send(body),
    patch: (path, body) => request(app).patch(path).set('Origin', TRUSTED_ORIGIN).send(body),
    delete: (path, body) => request(app).delete(path).set('Origin', TRUSTED_ORIGIN).send(body),
    request: (method, path, body) => sendRequest(app, method, path, body)
  };
}

module.exports = { asUser, anonymous, request, TRUSTED_ORIGIN };
