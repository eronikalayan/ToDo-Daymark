'use strict';

/**
 * REF-008-style unit tests for the rate-limit factories (REF-012, finding BE-003).
 *
 * These exercise the middleware in isolation on a throwaway Express app, with no
 * database and no application routes, so the keying and layering rules can be
 * checked precisely rather than inferred from endpoint behaviour.
 */
require('../helpers/guard'); // MUST be first — see helpers/guard.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { accountKey, perIpLimit, perAccountLimit, perAccountSoftLimit, perUserLimit } =
  require('../../src/middleware/rate-limit');
const { errorHandler } = require('../../src/middleware/error-handler');

/** A minimal app: body parser, the limiters under test, an echo route, error handler. */
function appWith(...middleware) {
  const app = express();
  app.use(express.json());
  app.post('/probe', ...middleware, (request_, response) =>
    response.json({ reached: true, suppressed: Boolean(request_.emailDeliverySuppressed) })
  );
  app.use(errorHandler);
  return app;
}

describe('accountKey', () => {
  const key = (body) => accountKey({ body });

  test('normalises exactly as the Zod schema does', () => {
    assert.equal(key({ email: '  Ada@Example.TEST  ' }), 'ada@example.test');
    assert.equal(key({ email: 'ada@example.test' }), 'ada@example.test');
  });

  test('case and whitespace variants collapse to one key', () => {
    const variants = ['a@x.com', 'A@x.com', 'a@X.COM', ' a@x.com ', 'A@X.COM'];
    assert.equal(new Set(variants.map((email) => key({ email }))).size, 1);
  });

  test('returns null when there is nothing usable to key on', () => {
    // Limiters run before validation, so the body may be absent, the wrong type,
    // or empty. None of these may throw.
    for (const body of [undefined, null, {}, { email: null }, { email: 42 }, { email: '' }, { email: '   ' }]) {
      assert.equal(key(body), null, JSON.stringify(body));
    }
  });

  test('distinct addresses produce distinct keys', () => {
    assert.notEqual(key({ email: 'a@x.com' }), key({ email: 'b@x.com' }));
  });
});

describe('perIpLimit', () => {
  test('rejects with 429 and the project error envelope once exceeded', async () => {
    const app = appWith(perIpLimit({ windowMs: 60_000, limit: 2, message: 'Too many.' }));
    assert.equal((await request(app).post('/probe').send({})).status, 200);
    assert.equal((await request(app).post('/probe').send({})).status, 200);

    const blocked = await request(app).post('/probe').send({});
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'RATE_LIMITED');
    assert.equal(blocked.body.error.message, 'Too many.');
  });

  test('counts regardless of the address, so varying it grants nothing', async () => {
    const app = appWith(perIpLimit({ windowMs: 60_000, limit: 2, message: 'Too many.' }));
    await request(app).post('/probe').send({ email: 'a@x.com' });
    await request(app).post('/probe').send({ email: 'b@x.com' });
    const blocked = await request(app).post('/probe').send({ email: 'c@x.com' });
    assert.equal(blocked.status, 429, 'the IP layer must survive address variation');
  });

  test('skipSuccessfulRequests leaves successful calls uncounted', async () => {
    // The route answers 200, so with skipSuccessfulRequests nothing accumulates.
    const app = appWith(perIpLimit({ windowMs: 60_000, limit: 2, message: 'Too many.', skipSuccessfulRequests: true }));
    for (let i = 0; i < 6; i += 1) {
      assert.equal((await request(app).post('/probe').send({})).status, 200, `call ${i + 1}`);
    }
  });
});

describe('perAccountLimit', () => {
  test('each address gets its own budget', async () => {
    const app = appWith(perAccountLimit({ windowMs: 60_000, limit: 2, message: 'Too many.' }));
    await request(app).post('/probe').send({ email: 'victim@x.com' });
    await request(app).post('/probe').send({ email: 'victim@x.com' });
    assert.equal((await request(app).post('/probe').send({ email: 'victim@x.com' })).status, 429);

    // A different account must be unaffected.
    assert.equal((await request(app).post('/probe').send({ email: 'other@x.com' })).status, 200);
  });

  test('a case variant cannot escape an exhausted budget', async () => {
    const app = appWith(perAccountLimit({ windowMs: 60_000, limit: 2, message: 'Too many.' }));
    await request(app).post('/probe').send({ email: 'victim@x.com' });
    await request(app).post('/probe').send({ email: 'VICTIM@x.com' });

    for (const variant of ['victim@x.com', 'Victim@X.com', '  victim@x.com  ']) {
      assert.equal((await request(app).post('/probe').send({ email: variant })).status, 429, variant);
    }
  });

  test('is skipped — not crashed — when the body carries no address', async () => {
    const app = appWith(perAccountLimit({ windowMs: 60_000, limit: 1, message: 'Too many.' }));
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await request(app).post('/probe').send({})).status, 200, `call ${i + 1}`);
    }
  });

  test('does not reveal which layer rejected', async () => {
    const message = 'Too many authentication attempts. Try again later.';
    const ip = appWith(perIpLimit({ windowMs: 60_000, limit: 1, message }));
    const account = appWith(perAccountLimit({ windowMs: 60_000, limit: 1, message }));

    await request(ip).post('/probe').send({ email: 'a@x.com' });
    await request(account).post('/probe').send({ email: 'a@x.com' });
    const fromIp = await request(ip).post('/probe').send({ email: 'a@x.com' });
    const fromAccount = await request(account).post('/probe').send({ email: 'a@x.com' });

    // Identical responses: a caller cannot tell an account-level block from an
    // address-level one, which would otherwise confirm the account exists.
    assert.deepEqual(fromAccount.body, fromIp.body);
    assert.equal(fromAccount.status, fromIp.status);
  });
});

describe('perAccountSoftLimit', () => {
  test('suppresses the email without rejecting the request', async () => {
    const app = appWith(perAccountSoftLimit({ windowMs: 60_000, limit: 2 }));

    for (let i = 0; i < 2; i += 1) {
      const allowed = await request(app).post('/probe').send({ email: 'victim@x.com' });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.body.suppressed, false, `call ${i + 1} should still deliver`);
    }

    // Over budget: the route still runs, only delivery is withheld. This is what
    // stops an account-keyed limit becoming a denial of service on the victim.
    for (let i = 0; i < 3; i += 1) {
      const suppressed = await request(app).post('/probe').send({ email: 'victim@x.com' });
      assert.equal(suppressed.status, 200, 'the endpoint must stay usable');
      assert.equal(suppressed.body.suppressed, true);
    }
  });

  test('suppression is per account', async () => {
    const app = appWith(perAccountSoftLimit({ windowMs: 60_000, limit: 1 }));
    await request(app).post('/probe').send({ email: 'a@x.com' });
    assert.equal((await request(app).post('/probe').send({ email: 'a@x.com' })).body.suppressed, true);
    assert.equal((await request(app).post('/probe').send({ email: 'b@x.com' })).body.suppressed, false);
  });

  test('case variants share the suppression budget', async () => {
    const app = appWith(perAccountSoftLimit({ windowMs: 60_000, limit: 1 }));
    await request(app).post('/probe').send({ email: 'a@x.com' });
    assert.equal((await request(app).post('/probe').send({ email: 'A@X.COM' })).body.suppressed, true);
  });
});

describe('perUserLimit', () => {
  test('keys on the authenticated user when present', async () => {
    const asUser = (id) => (request_, response, next) => {
      request_.user = { id };
      next();
    };
    const limiter = perUserLimit({ windowMs: 60_000, limit: 1, message: 'Too many.' });

    const appA = appWith(asUser('user-1'), limiter);
    await request(appA).post('/probe').send({});
    assert.equal((await request(appA).post('/probe').send({})).status, 429);

    // A different user shares the process but not the budget.
    const appB = appWith(asUser('user-2'), limiter);
    assert.equal((await request(appB).post('/probe').send({})).status, 200);
  });
});

describe('factory isolation — the actual BE-003 defect', () => {
  test('two limiters from the same factory keep independent counters', async () => {
    // BE-003 was one limiter INSTANCE mounted on five routes, which shares a
    // counter store. Separate instances must not.
    const options = { windowMs: 60_000, limit: 1, message: 'Too many.' };
    const first = appWith(perIpLimit(options));
    const second = appWith(perIpLimit(options));

    await request(first).post('/probe').send({});
    assert.equal((await request(first).post('/probe').send({})).status, 429, 'first limiter is exhausted');
    assert.equal((await request(second).post('/probe').send({})).status, 200, 'second limiter must be untouched');
  });

  test('reusing ONE instance across routes shares the counter — the shape to avoid', async () => {
    // Documents the defect so the distinction cannot be lost again.
    const shared = perIpLimit({ windowMs: 60_000, limit: 1, message: 'Too many.' });
    const app = express();
    app.use(express.json());
    app.post('/a', shared, (request_, response) => response.json({ ok: true }));
    app.post('/b', shared, (request_, response) => response.json({ ok: true }));
    app.use(errorHandler);

    assert.equal((await request(app).post('/a').send({})).status, 200);
    assert.equal((await request(app).post('/b').send({})).status, 429, 'a shared instance leaks budget across routes');
  });
});
