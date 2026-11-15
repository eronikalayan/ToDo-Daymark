'use strict';

/**
 * Task creator lifecycle — the permanent regression guard for BE-001.
 *
 * `tasks.created_by_id` records who SENT a task; `tasks.user_id` records who OWNS
 * it. Before REF-010 both foreign keys cascaded, so a user deleting their own
 * account silently deleted tasks belonging to the people they had sent tasks to.
 *
 * Migration 20261113070000_fix_task_creator_cascade made `created_by_id` nullable
 * with ON DELETE SET NULL. These tests started life in test/known-defects/ as
 * failing assertions describing the desired behaviour; they now pass and live in
 * the stable suite, where they prevent the defect from returning.
 *
 * The asymmetry between the two foreign keys is the whole point and is asserted
 * from both sides: CASCADE on ownership, SET NULL on provenance.
 */
require('./helpers/guard'); // MUST be first — see helpers/guard.js

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../src/app');
const F = require('./helpers/factories');
const { asUser } = require('./helpers/client');

after(async () => {
  await F.cleanup();
  await F.disconnect();
});

/** Sender and recipient become friends; the sender assigns a task the recipient owns. */
async function arrangeAssignedTask() {
  const { a: sender, b: recipient } = await F.createFriends();

  const assignment = await asUser(app, sender).post('/api/tasks', {
    title: 'Task the recipient owns',
    assignedToId: recipient.id
  });
  assert.equal(assignment.status, 201, 'arrangement failed: the task was not created');

  const task = assignment.body.data.task;
  assert.equal(task.userId, recipient.id, 'arrangement failed: the recipient must own the task');
  assert.equal(task.createdById, sender.id, 'arrangement failed: the sender must be recorded as creator');

  return { sender, recipient, task };
}

describe('BE-001: a deleted creator must not destroy the recipient\'s task', () => {
  test('the task row survives the creator deleting their account', async () => {
    const { sender, recipient, task } = await arrangeAssignedTask();

    const deleted = await asUser(app, sender).delete('/api/auth/me', { password: sender.password });
    assert.equal(deleted.status, 204, 'the sender should be able to delete their own account');

    const row = await F.prisma.task.findUnique({ where: { id: task.id } });
    assert.notEqual(row, null, "the recipient's task must not be deleted with the creator's account");
    assert.equal(row.userId, recipient.id, 'the task must still belong to the recipient');
  });

  test('the recipient can still see the task in their list', async () => {
    const { sender, recipient, task } = await arrangeAssignedTask();
    await asUser(app, sender).delete('/api/auth/me', { password: sender.password });

    const list = await asUser(app, recipient).get('/api/tasks');
    assert.equal(list.status, 200);
    assert.equal(list.body.data.tasks.some((t) => t.id === task.id), true);
  });

  test('the recipient can still read the task directly', async () => {
    const { sender, recipient, task } = await arrangeAssignedTask();
    await asUser(app, sender).delete('/api/auth/me', { password: sender.password });

    const response = await asUser(app, recipient).get(`/api/tasks/${task.id}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.task.id, task.id);
  });

  test('the creator reference becomes null rather than taking the task with it', async () => {
    const { sender, task } = await arrangeAssignedTask();
    await asUser(app, sender).delete('/api/auth/me', { password: sender.password });

    const row = await F.prisma.task.findUnique({ where: { id: task.id } });
    assert.notEqual(row, null);
    assert.equal(row.createdById, null, 'createdById should be NULL once the creator is gone');
  });

  test('the task remains fully usable: it can still be updated, toggled and deleted', async () => {
    const { sender, recipient, task } = await arrangeAssignedTask();
    await asUser(app, sender).delete('/api/auth/me', { password: sender.password });
    const asRecipient = asUser(app, recipient);

    const updated = await asRecipient.patch(`/api/tasks/${task.id}`, { title: 'Renamed after the sender left' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.task.title, 'Renamed after the sender left');
    assert.equal(updated.body.data.task.createdById, null, 'an update must not resurrect a creator reference');

    const toggled = await asRecipient.patch(`/api/tasks/${task.id}/toggle`);
    assert.equal(toggled.status, 200);
    assert.equal(toggled.body.data.task.completed, true);

    assert.equal((await asRecipient.delete(`/api/tasks/${task.id}`)).status, 204);
  });

  test('the API exposes createdById as null, which clients must tolerate', async () => {
    const { sender, recipient, task } = await arrangeAssignedTask();
    await asUser(app, sender).delete('/api/auth/me', { password: sender.password });

    const response = await asUser(app, recipient).get(`/api/tasks/${task.id}`);
    assert.equal(response.status, 200);
    assert.ok('createdById' in response.body.data.task, 'the field must still be present, not omitted');
    assert.equal(response.body.data.task.createdById, null);
  });
});

describe('the ownership cascade is deliberately NOT affected', () => {
  test("a user's own tasks are still deleted with their account", async () => {
    const user = await F.createSignedInUser();
    const own = await F.createTask(user.id);

    await asUser(app, user).delete('/api/auth/me', { password: user.password });

    assert.equal(await F.prisma.task.findUnique({ where: { id: own.id } }), null);
  });

  test('deleting the recipient removes the assigned task they owned', async () => {
    // Ownership cascades even when somebody else created the task: the task
    // belongs to the recipient, so it goes with them.
    const { sender, recipient, task } = await arrangeAssignedTask();

    await asUser(app, recipient).delete('/api/auth/me', { password: recipient.password });

    assert.equal(await F.prisma.task.findUnique({ where: { id: task.id } }), null);
    assert.equal(await F.prisma.user.count({ where: { id: sender.id } }), 1, 'the sender must be unaffected');
  });
});

describe('invariants that hold because of the asymmetry', () => {
  test('a task never loses its owner, even when its creator is gone', async () => {
    // The two foreign keys must stay asymmetric: ownership cascades, provenance
    // is cleared. A task with no owner would mean they had drifted back together
    // (or that user_id had been made nullable), so the invariant is checked
    // across the whole table rather than only for the task under test.
    const { sender, recipient, task } = await arrangeAssignedTask();
    await asUser(app, sender).delete('/api/auth/me', { password: sender.password });

    const survivor = await F.prisma.task.findUnique({ where: { id: task.id } });
    assert.equal(survivor.userId, recipient.id, 'ownership must be untouched');
    assert.equal(survivor.createdById, null, 'provenance must be cleared');

    const ownerless = await F.prisma.$queryRaw`SELECT COUNT(*) AS c FROM tasks WHERE user_id IS NULL`;
    assert.equal(Number(ownerless[0].c), 0, 'no task may exist without an owner');
  });

  test('a self-created task is removed with its owner, so it can never be left creator-less', async () => {
    // For a self-created task the owner IS the creator, so user_id's CASCADE
    // removes the row first and created_by_id never gets the chance to be nulled.
    const user = await F.createSignedInUser();
    const own = await F.createTask(user.id);
    assert.equal(own.userId, own.createdById, 'arrangement: this task must be self-created');

    await asUser(app, user).delete('/api/auth/me', { password: user.password });
    assert.equal(await F.prisma.task.findUnique({ where: { id: own.id } }), null);
  });

  test('newly created tasks always record their creator', async () => {
    const user = await F.createSignedInUser();
    const response = await asUser(app, user).post('/api/tasks', { title: 'Fresh task' });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.task.createdById, user.id, 'creation must still populate createdById');
    assert.notEqual(response.body.data.task.createdById, null);
  });

  test('assignment still records the sender as creator', async () => {
    const { a: sender, b: recipient } = await F.createFriends();
    const response = await asUser(app, sender).post('/api/tasks', {
      title: 'Assigned task',
      assignedToId: recipient.id
    });
    assert.equal(response.body.data.task.createdById, sender.id);
    assert.equal(response.body.data.task.userId, recipient.id);
  });
});
