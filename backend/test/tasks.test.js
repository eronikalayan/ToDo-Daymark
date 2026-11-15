'use strict';

// REF-007 — task suite, split out of the original test/api.test.js.
require('./helpers/guard'); // MUST be first — see helpers/guard.js

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../src/app');
const F = require('./helpers/factories');
const { asUser, anonymous } = require('./helpers/client');

after(async () => {
  await F.cleanup();
  await F.disconnect();
});

describe('authentication is required', () => {
  test('listing tasks without a session returns 401', async () => {
    assert.equal((await anonymous(app).get('/api/tasks')).status, 401);
  });

  test('creating a task without a session returns 401', async () => {
    assert.equal((await anonymous(app).post('/api/tasks', { title: 'nope' })).status, 401);
  });
});

describe('creating tasks', () => {
  test('stores the title verbatim and applies defaults', async () => {
    const user = await F.createSignedInUser();
    const response = await asUser(app, user).post('/api/tasks', {
      title: '<script>launch()</script>',
      description: 'Prepare the release checklist',
      dueDate: '2026-12-01',
      priority: 'high'
    });

    assert.equal(response.status, 201);
    // Escaping belongs to the renderer, not a JSON API: the value round-trips raw.
    assert.equal(response.body.data.task.title, '<script>launch()</script>');
    assert.equal(response.body.data.task.priority, 'high');
    assert.equal(response.body.data.task.completed, false);
    assert.equal(response.body.data.task.userId, user.id);
    assert.equal(response.body.data.task.createdById, user.id);
  });

  test('rejects an impossible calendar date', async () => {
    const user = await F.createSignedInUser();
    const response = await asUser(app, user).post('/api/tasks', { title: 'Bad date', dueDate: '2026-02-31' });
    assert.equal(response.status, 422);
  });

  test('rejects unknown fields', async () => {
    const user = await F.createSignedInUser();
    const response = await asUser(app, user).post('/api/tasks', { title: 'x', nope: 1 });
    assert.equal(response.status, 422);
  });
});

describe('listing, filtering and sorting', () => {
  test('filters by completion, priority, search text and pagination', async () => {
    const user = await F.createSignedInUser();
    await asUser(app, user).post('/api/tasks', {
      title: 'Launch project',
      description: 'Prepare the release checklist',
      dueDate: '2026-12-01',
      priority: 'high'
    });
    await F.createTask(user.id, { title: 'Unrelated chore', priority: 'low' });

    const response = await asUser(app, user).get(
      '/api/tasks?completed=false&priority=high&search=release&page=1&limit=5'
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.data.tasks.length, 1);
    assert.equal(response.body.meta.pagination.total, 1);
  });

  test('a single-day due-date range includes that whole day', async () => {
    const user = await F.createSignedInUser();
    await asUser(app, user).post('/api/tasks', { title: 'Due that day', dueDate: '2026-12-01', priority: 'high' });

    const response = await asUser(app, user).get(
      '/api/tasks?dueAfter=2026-12-01&dueBefore=2026-12-01&sortBy=dueDate&order=asc'
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.data.tasks.length, 1);
  });

  test('sorts by priority', async () => {
    const user = await F.createSignedInUser();
    await F.createTask(user.id, { priority: 'low' });
    await F.createTask(user.id, { priority: 'high' });

    const response = await asUser(app, user).get('/api/tasks?sortBy=priority&order=desc');
    assert.equal(response.body.data.tasks[0].priority, 'high');
  });

  test('returns an empty array and zero pages when nothing matches', async () => {
    const user = await F.createSignedInUser();
    const response = await asUser(app, user).get('/api/tasks?search=zzzznomatchzzzz');
    assert.deepEqual(response.body.data.tasks, []);
    assert.equal(response.body.meta.pagination.pages, 0);
  });

  test('rejects an invalid completed filter', async () => {
    const user = await F.createSignedInUser();
    assert.equal((await asUser(app, user).get('/api/tasks?completed=maybe')).status, 422);
  });

  test('rejects an inverted due-date range', async () => {
    const user = await F.createSignedInUser();
    assert.equal((await asUser(app, user).get('/api/tasks?dueAfter=2026-12-10&dueBefore=2026-12-01')).status, 422);
  });
});

describe('updating and completing', () => {
  test('toggling sets completed and completedAt', async () => {
    const user = await F.createSignedInUser();
    const task = await F.createTask(user.id);

    const toggled = await asUser(app, user).patch(`/api/tasks/${task.id}/toggle`);
    assert.equal(toggled.status, 200);
    assert.equal(toggled.body.data.task.completed, true);
    assert.ok(toggled.body.data.task.completedAt);
  });

  test('clearing completion resets completedAt to null', async () => {
    const user = await F.createSignedInUser();
    const task = await F.createTask(user.id);
    await asUser(app, user).patch(`/api/tasks/${task.id}/toggle`);

    const edited = await asUser(app, user).patch(`/api/tasks/${task.id}`, {
      title: 'Launch project v2',
      completed: false
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.data.task.title, 'Launch project v2');
    assert.equal(edited.body.data.task.completed, false);
    assert.equal(edited.body.data.task.completedAt, null);
  });

  test('deleting removes the task', async () => {
    const user = await F.createSignedInUser();
    const task = await F.createTask(user.id);

    assert.equal((await asUser(app, user).delete(`/api/tasks/${task.id}`)).status, 204);
    assert.equal((await asUser(app, user).get(`/api/tasks/${task.id}`)).status, 404);
  });

  test('a well-formed but unknown id is 404, a malformed id is 422', async () => {
    const user = await F.createSignedInUser();
    const unknown = await asUser(app, user).get('/api/tasks/11111111-2222-4333-8444-555555555555');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'TASK_NOT_FOUND');
    assert.equal((await asUser(app, user).get('/api/tasks/not-a-uuid')).status, 422);
  });
});

describe('ownership isolation', () => {
  test("another user's task is 404 for every verb", async () => {
    const owner = await F.createSignedInUser();
    const intruder = await F.createSignedInUser();
    const task = await F.createTask(owner.id);
    const asIntruder = asUser(app, intruder);

    for (const response of [
      await asIntruder.get(`/api/tasks/${task.id}`),
      await asIntruder.patch(`/api/tasks/${task.id}`, { title: 'Try to edit' }),
      await asIntruder.patch(`/api/tasks/${task.id}/toggle`),
      await asIntruder.delete(`/api/tasks/${task.id}`)
    ]) {
      assert.equal(response.status, 404);
      assert.equal(response.body.error.code, 'TASK_NOT_FOUND');
    }

    // The task must still exist and still belong to its owner.
    const still = await asUser(app, owner).get(`/api/tasks/${task.id}`);
    assert.equal(still.status, 200);
  });

  test('ownership cannot be reassigned through an update', async () => {
    const owner = await F.createSignedInUser();
    const other = await F.createSignedInUser();
    const task = await F.createTask(owner.id);

    const response = await asUser(app, owner).patch(`/api/tasks/${task.id}`, { userId: other.id });
    assert.equal(response.status, 422);
  });
});

describe('recipient-owned assignment', () => {
  test('an assigned task belongs to the recipient and is invisible to the sender', async () => {
    const { a: sender, b: recipient } = await F.createFriends();

    const assignment = await asUser(app, sender).post('/api/tasks', {
      title: 'Recipient-only task',
      assignedToId: recipient.id
    });
    assert.equal(assignment.status, 201);
    const task = assignment.body.data.task;
    assert.equal(task.userId, recipient.id);
    assert.equal(task.createdById, sender.id);

    const senderList = await asUser(app, sender).get('/api/tasks');
    assert.equal(senderList.body.data.tasks.some((t) => t.id === task.id), false);

    const recipientList = await asUser(app, recipient).get('/api/tasks');
    assert.equal(recipientList.body.data.tasks.some((t) => t.id === task.id), true);
  });

  test('the sender retains no access to the assigned task', async () => {
    const { a: sender, b: recipient } = await F.createFriends();
    const assignment = await asUser(app, sender).post('/api/tasks', {
      title: 'Recipient-only task',
      assignedToId: recipient.id
    });
    const taskId = assignment.body.data.task.id;
    const asSender = asUser(app, sender);

    assert.equal((await asSender.get(`/api/tasks/${taskId}`)).status, 404);
    assert.equal((await asSender.patch(`/api/tasks/${taskId}`, { title: 'Sender edit' })).status, 404);
    assert.equal((await asSender.patch(`/api/tasks/${taskId}/toggle`)).status, 404);
  });

  test('the recipient can complete it, and it stays out of the sender\'s completed list', async () => {
    const { a: sender, b: recipient } = await F.createFriends();
    const assignment = await asUser(app, sender).post('/api/tasks', {
      title: 'Recipient-only task',
      assignedToId: recipient.id
    });
    const taskId = assignment.body.data.task.id;

    const toggled = await asUser(app, recipient).patch(`/api/tasks/${taskId}/toggle`);
    assert.equal(toggled.status, 200);
    assert.equal(toggled.body.data.task.completed, true);

    const senderCompleted = await asUser(app, sender).get('/api/tasks?completed=true');
    assert.equal(senderCompleted.body.data.tasks.some((t) => t.id === taskId), false);
  });

  test('assignment creates a chat notification linked to the task', async () => {
    const { a: sender, b: recipient } = await F.createFriends();
    const assignment = await asUser(app, sender).post('/api/tasks', {
      title: 'Notified task',
      assignedToId: recipient.id
    });

    const messages = await asUser(app, recipient).get(`/api/friends/${sender.id}/messages`);
    assert.equal(messages.status, 200);
    assert.equal(messages.body.data.messages[0].taskId, assignment.body.data.task.id);
  });

  test('assigning to someone who is not an accepted friend returns 404', async () => {
    const sender = await F.createSignedInUser();
    const stranger = await F.createSignedInUser();

    const response = await asUser(app, sender).post('/api/tasks', {
      title: 'Cannot assign to stranger',
      assignedToId: stranger.id
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'FRIEND_NOT_FOUND');
  });

  test('assigning to a pending (not yet accepted) friend returns 404', async () => {
    const sender = await F.createSignedInUser();
    const pending = await F.createSignedInUser();
    await F.createFriendship(sender.id, pending.id, { status: 'pending' });

    const response = await asUser(app, sender).post('/api/tasks', {
      title: 'Not yet friends',
      assignedToId: pending.id
    });
    assert.equal(response.status, 404);
  });
});
