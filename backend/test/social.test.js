'use strict';

// REF-007 — friends and chat suite, split out of the original test/api.test.js.
require('./helpers/guard'); // MUST be first — see helpers/guard.js

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../src/app');
const F = require('./helpers/factories');
const { asUser, request } = require('./helpers/client');

after(async () => {
  await F.cleanup();
  await F.disconnect();
});

describe('friend requests', () => {
  test('sending a request, seeing it, and accepting it', async () => {
    const sender = await F.createSignedInUser();
    const addressee = await F.createSignedInUser();

    const sent = await asUser(app, sender).post('/api/friends/requests', { email: addressee.email });
    assert.equal(sent.status, 201);

    const incoming = await asUser(app, addressee).get('/api/friends');
    assert.equal(incoming.body.data.requests.length, 1);
    assert.equal(incoming.body.data.requests[0].direction, 'received');
    assert.equal(incoming.body.data.requests[0].user.email, sender.email);

    const accepted = await asUser(app, addressee).patch(
      `/api/friends/requests/${sent.body.data.request.id}`,
      { action: 'accept' }
    );
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.data.request.status, 'accepted');

    const friends = await asUser(app, sender).get('/api/friends');
    assert.equal(friends.body.data.friends.some((f) => f.id === addressee.id), true);
  });

  test('declining removes the request', async () => {
    const sender = await F.createSignedInUser();
    const addressee = await F.createSignedInUser();
    const sent = await asUser(app, sender).post('/api/friends/requests', { email: addressee.email });

    const declined = await asUser(app, addressee).patch(
      `/api/friends/requests/${sent.body.data.request.id}`,
      { action: 'decline' }
    );
    assert.equal(declined.status, 200);
    assert.equal(declined.body.data.request.status, 'declined');

    const after = await asUser(app, addressee).get('/api/friends');
    assert.equal(after.body.data.requests.length, 0);
  });

  test('a user cannot accept their own outgoing request', async () => {
    const sender = await F.createSignedInUser();
    const addressee = await F.createSignedInUser();
    const sent = await asUser(app, sender).post('/api/friends/requests', { email: addressee.email });

    const response = await asUser(app, sender).patch(
      `/api/friends/requests/${sent.body.data.request.id}`,
      { action: 'accept' }
    );
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'REQUEST_NOT_FOUND');
  });

  test('rejects self-requests, duplicates and requests to existing friends', async () => {
    const user = await F.createSignedInUser();
    const other = await F.createSignedInUser();

    const self = await asUser(app, user).post('/api/friends/requests', { email: user.email });
    assert.equal(self.status, 422);
    assert.equal(self.body.error.code, 'SELF_FRIEND_REQUEST');

    await asUser(app, user).post('/api/friends/requests', { email: other.email });
    const duplicate = await asUser(app, user).post('/api/friends/requests', { email: other.email });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'REQUEST_ALREADY_PENDING');

    const { a, b } = await F.createFriends();
    const alreadyFriends = await asUser(app, a).post('/api/friends/requests', { email: b.email });
    assert.equal(alreadyFriends.status, 409);
    assert.equal(alreadyFriends.body.error.code, 'ALREADY_FRIENDS');
  });

  test('a reciprocal pending request is auto-accepted', async () => {
    const a = await F.createSignedInUser();
    const b = await F.createSignedInUser();

    await asUser(app, a).post('/api/friends/requests', { email: b.email });
    const reciprocal = await asUser(app, b).post('/api/friends/requests', { email: a.email });

    assert.equal(reciprocal.status, 201);
    assert.equal(reciprocal.body.data.request.status, 'accepted');
  });

  test('removing a friend revokes conversation access', async () => {
    const { a, b } = await F.createFriends();
    await F.createMessage(a.id, b.id);

    assert.equal((await asUser(app, a).get(`/api/friends/${b.id}/messages`)).status, 200);
    assert.equal((await asUser(app, a).delete(`/api/friends/${b.id}`)).status, 204);

    const afterRemoval = await asUser(app, a).get(`/api/friends/${b.id}/messages`);
    assert.equal(afterRemoval.status, 404);
    assert.equal(afterRemoval.body.error.code, 'FRIEND_NOT_FOUND');
  });
});

describe('messaging', () => {
  test('stores the message body verbatim and returns it to both participants', async () => {
    const { a, b } = await F.createFriends();
    const payload = '<img src=x onerror=alert(1)>';

    const sent = await asUser(app, a).post(`/api/friends/${b.id}/messages`, { body: payload });
    assert.equal(sent.status, 201);

    const history = await asUser(app, b).get(`/api/friends/${a.id}/messages`);
    assert.equal(history.status, 200);
    assert.equal(history.body.data.messages.at(-1).body, payload);
    assert.equal(history.body.data.messages.at(-1).sender.id, a.id);
  });

  test('rejects an empty or oversized body', async () => {
    const { a, b } = await F.createFriends();
    assert.equal((await asUser(app, a).post(`/api/friends/${b.id}/messages`, { body: '    ' })).status, 422);
    assert.equal((await asUser(app, a).post(`/api/friends/${b.id}/messages`, { body: 'x'.repeat(501) })).status, 422);
  });

  test('a non-friend cannot read or write a conversation', async () => {
    const { a, b } = await F.createFriends();
    const intruder = await F.createSignedInUser();
    await F.createMessage(a.id, b.id);

    assert.equal((await asUser(app, intruder).get(`/api/friends/${a.id}/messages`)).status, 404);
    assert.equal((await asUser(app, intruder).post(`/api/friends/${a.id}/messages`, { body: 'hi' })).status, 404);
  });

  test('a user cannot message themselves', async () => {
    const user = await F.createSignedInUser();
    assert.equal((await asUser(app, user).post(`/api/friends/${user.id}/messages`, { body: 'hi me' })).status, 404);
  });

  test('paginates a conversation', async () => {
    const { a, b } = await F.createFriends();
    for (let i = 1; i <= 5; i += 1) {
      await F.createMessage(a.id, b.id, { body: `msg${i}`, createdAt: new Date(Date.now() + i * 1000) });
    }

    const page = await asUser(app, a).get(`/api/friends/${b.id}/messages?page=1&limit=2`);
    assert.equal(page.status, 200);
    assert.equal(page.body.data.messages.length, 2);
    assert.equal(page.body.meta.pagination.total, 5);
    assert.equal(page.body.meta.pagination.pages, 3);
  });
});

describe('cross-origin write protection', () => {
  // Two independent layers reject a cross-site write, in this order:
  //   1. cors() rejects any Origin outside the allowlist          -> CORS_ORIGIN_DENIED
  //   2. the CSRF guard rejects a cookie-bearing mutation that     -> CSRF_ORIGIN_DENIED
  //      carries no Origin at all (curl, a native client, ...)
  // An untrusted Origin therefore never reaches layer 2; both are asserted here
  // so a future change to either one cannot silently remove the protection.
  test('layer 1: a mutation from an untrusted origin is rejected by CORS', async () => {
    const { a, b } = await F.createFriends();

    const response = await request(app)
      .post(`/api/friends/${b.id}/messages`)
      .set('Cookie', a.cookie)
      .set('Origin', 'https://attacker.example')
      .send({ body: 'CSRF attempt' });

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'CORS_ORIGIN_DENIED');
  });

  test('layer 2: a cookie-bearing mutation with no Origin is rejected by the CSRF guard', async () => {
    const { a, b } = await F.createFriends();

    const response = await request(app)
      .post(`/api/friends/${b.id}/messages`)
      .set('Cookie', a.cookie)
      .send({ body: 'no origin header' });

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'CSRF_ORIGIN_DENIED');
  });

  test('the same mutation from an allowlisted origin succeeds', async () => {
    const { a, b } = await F.createFriends();
    assert.equal((await asUser(app, a).post(`/api/friends/${b.id}/messages`, { body: 'legitimate' })).status, 201);
  });
});
