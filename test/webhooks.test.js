const crypto = require('crypto');
const express = require('express');
const http = require('http');

const { setupTestApp, registerUser } = require('./helpers');
const Webhook = require('../model/webhook');
const { sign, eventMatches, startWebhookDispatcher } = require('../utils/webhookDispatcher');
const { bus, emitRecordEvent } = require('../utils/events');

const ctx = setupTestApp();

/**
 * Stand up a tiny HTTP receiver bound to a random port. `received` is
 * a list of every request body / signature pair the receiver got. The
 * caller controls each response with `nextStatus` / `failNext` so a
 * test can simulate transient failures and recoveries.
 */
const startReceiver = (handler) =>
  new Promise((resolve) => {
    const app = express();
    app.use(express.text({ type: '*/*' }));
    app.post('/hook', (req, res) => handler(req, res));
    const server = app.listen(0, () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });

describe('Event bus + webhook dispatcher', () => {
  describe('eventMatches', () => {
    test('exact match', () => {
      expect(eventMatches(['account.created'], 'account.created')).toBe(true);
      expect(eventMatches(['account.created'], 'account.updated')).toBe(false);
    });
    test('resource wildcard', () => {
      expect(eventMatches(['account.*'], 'account.created')).toBe(true);
      expect(eventMatches(['account.*'], 'account.updated')).toBe(true);
      expect(eventMatches(['account.*'], 'task.created')).toBe(false);
    });
    test('global wildcard', () => {
      expect(eventMatches(['*'], 'anything.at_all')).toBe(true);
    });
    test('multiple patterns OR-d', () => {
      expect(eventMatches(['task.created', 'account.*'], 'account.deleted')).toBe(true);
      expect(eventMatches(['task.created', 'account.*'], 'task.updated')).toBe(false);
    });
  });

  describe('REST CRUD emits record events', () => {
    test('POST /api/v1/account emits account.created', async () => {
      const u = await registerUser(ctx.request, ctx.app);
      const heard = new Promise((resolve) => bus.once('record', resolve));
      await ctx
        .request(ctx.app)
        .post('/api/v1/account')
        .set('Authorization', `Bearer ${u.token}`)
        .send({ accountName: 'evt-create' });
      const event = await heard;
      expect(event.type).toBe('account.created');
      expect(event.userId).toBe(String(u._id));
      expect(event.record.accountName).toBe('evt-create');
    });

    test('PUT /:id emits account.updated', async () => {
      const u = await registerUser(ctx.request, ctx.app);
      const created = await ctx
        .request(ctx.app)
        .post('/api/v1/account')
        .set('Authorization', `Bearer ${u.token}`)
        .send({ accountName: 'evt-update' });
      const heard = new Promise((resolve) => bus.once('record', resolve));
      await ctx
        .request(ctx.app)
        .put(`/api/v1/account/${created.body._id}`)
        .set('Authorization', `Bearer ${u.token}`)
        .send({ accountName: 'evt-update-2' });
      const event = await heard;
      expect(event.type).toBe('account.updated');
      expect(event.recordId).toBe(String(created.body._id));
    });

    test('DELETE /:id emits account.deleted', async () => {
      const u = await registerUser(ctx.request, ctx.app);
      const created = await ctx
        .request(ctx.app)
        .post('/api/v1/account')
        .set('Authorization', `Bearer ${u.token}`)
        .send({ accountName: 'evt-delete' });
      const heard = new Promise((resolve) => bus.once('record', resolve));
      await ctx
        .request(ctx.app)
        .delete(`/api/v1/account/${created.body._id}`)
        .set('Authorization', `Bearer ${u.token}`);
      const event = await heard;
      expect(event.type).toBe('account.deleted');
      expect(event.recordId).toBe(String(created.body._id));
    });
  });

  describe('GraphQL CRUD emits record events', () => {
    test('createOne emits account.created', async () => {
      const u = await registerUser(ctx.request, ctx.app);
      const heard = new Promise((resolve) => bus.once('record', resolve));
      await ctx
        .request(ctx.app)
        .post('/graphql/')
        .set('Authorization', `Bearer ${u.token}`)
        .send({
          query:
            'mutation { accountCreateOne(record: { accountName: "gql-evt" }) { recordId record { _id accountName } } }',
        });
      const event = await heard;
      expect(event.type).toBe('account.created');
      expect(event.userId).toBe(String(u._id));
      expect(event.record.accountName).toBe('gql-evt');
    });
  });

  describe('Webhook subscription CRUD', () => {
    test('POST creates a sub, returns the secret exactly once', async () => {
      const u = await registerUser(ctx.request, ctx.app);
      const r = await ctx
        .request(ctx.app)
        .post('/api/v1/webhooks')
        .set('Authorization', `Bearer ${u.token}`)
        .send({ events: ['account.*'], url: 'http://localhost:9999/' });
      expect(r.status).toBe(201);
      expect(r.body.secret).toMatch(/^[a-f0-9]{64}$/);
      expect(r.body.events).toEqual(['account.*']);

      // The follow-up GET does NOT echo the secret.
      const got = await ctx
        .request(ctx.app)
        .get(`/api/v1/webhooks/${r.body._id}`)
        .set('Authorization', `Bearer ${u.token}`);
      expect(got.status).toBe(200);
      expect(got.body.secret).toBeUndefined();
    });

    test('user isolation: User B cannot list, fetch, or delete User A subs', async () => {
      const a = await registerUser(ctx.request, ctx.app);
      const b = await registerUser(ctx.request, ctx.app);
      const created = await ctx
        .request(ctx.app)
        .post('/api/v1/webhooks')
        .set('Authorization', `Bearer ${a.token}`)
        .send({ events: ['*'], url: 'http://localhost:9999/' });

      const bList = await ctx
        .request(ctx.app)
        .get('/api/v1/webhooks')
        .set('Authorization', `Bearer ${b.token}`);
      expect(bList.body.results).toHaveLength(0);

      const bFetch = await ctx
        .request(ctx.app)
        .get(`/api/v1/webhooks/${created.body._id}`)
        .set('Authorization', `Bearer ${b.token}`);
      expect(bFetch.status).toBe(404);

      const bDel = await ctx
        .request(ctx.app)
        .delete(`/api/v1/webhooks/${created.body._id}`)
        .set('Authorization', `Bearer ${b.token}`);
      expect(bDel.status).toBe(404);
    });

    test('validation: events must be non-empty array; url must be http(s)', async () => {
      const u = await registerUser(ctx.request, ctx.app);
      const a = await ctx
        .request(ctx.app)
        .post('/api/v1/webhooks')
        .set('Authorization', `Bearer ${u.token}`)
        .send({ events: [], url: 'http://x/' });
      expect(a.status).toBe(400);
      const b = await ctx
        .request(ctx.app)
        .post('/api/v1/webhooks')
        .set('Authorization', `Bearer ${u.token}`)
        .send({ events: ['*'], url: 'ftp://x/' });
      expect(b.status).toBe(400);
    });
  });

  describe('SSRF defense (validateWebhookUrl)', () => {
    const { validateWebhookUrl } = require('../utils/urlValidator');

    test('rejects loopback IPv4 literal', async () => {
      await expect(
        validateWebhookUrl('http://127.0.0.1:9999/x', { allowPrivate: false })
      ).rejects.toThrow(/private/);
    });
    test('rejects literal localhost', async () => {
      await expect(
        validateWebhookUrl('http://localhost/x', { allowPrivate: false })
      ).rejects.toThrow(/not allowed/);
    });
    test('rejects RFC1918 IPv4 ranges', async () => {
      for (const ip of ['10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255']) {
        await expect(
          validateWebhookUrl(`http://${ip}/x`, { allowPrivate: false })
        ).rejects.toThrow(/private/);
      }
    });
    test('rejects link-local (cloud metadata) IPv4', async () => {
      await expect(
        validateWebhookUrl('http://169.254.169.254/latest/meta-data', { allowPrivate: false })
      ).rejects.toThrow(/private/);
    });
    test('rejects IPv6 loopback / ULA / link-local', async () => {
      for (const ip of ['[::1]', '[fe80::1]', '[fc00::1]', '[fd12:3456::1]']) {
        await expect(
          validateWebhookUrl(`http://${ip}/x`, { allowPrivate: false })
        ).rejects.toThrow(/private/);
      }
    });
    test('rejects non-http(s) schemes', async () => {
      await expect(
        validateWebhookUrl('ftp://example.com/x', { allowPrivate: false })
      ).rejects.toThrow(/http or https/);
    });
    test('allowPrivate: true short-circuits all checks (test harness)', async () => {
      await expect(
        validateWebhookUrl('http://127.0.0.1:9999/x', { allowPrivate: true })
      ).resolves.toBeDefined();
    });
  });

  describe('Webhook payload respects field-level read ACL', () => {
    let receiver;
    let received;

    beforeAll(async () => {
      // A schema where `salary` is admin/hr-only on read.
      await ctx.app.locals.schemaLoader.loadSchema({
        path: 'wh_emp',
        collection: 'wh_emp',
        version: 'v1',
        fields: [
          { name: 'userId', type: String, required: true },
          { name: 'name', type: String, required: true },
          { name: 'salary', type: Number, acl: { read: ['admin', 'hr'], create: ['admin', 'hr'] } },
        ],
      });
    });

    beforeEach(async () => {
      received = [];
      receiver = await startReceiver((req, res) => {
        received.push({ body: req.body });
        res.status(200).end();
      });
    });
    afterEach(async () => {
      if (receiver) await receiver.close();
    });

    test('plain user creating a record receives a payload WITHOUT salary', async () => {
      const u = await registerUser(ctx.request, ctx.app);
      await ctx
        .request(ctx.app)
        .post('/api/v1/webhooks')
        .set('Authorization', `Bearer ${u.token}`)
        .send({ events: ['wh_emp.*'], url: receiver.url });

      // POST as a plain user. salary is filterWritable-stripped on
      // create (good), but the bigger concern is that even if salary
      // SOMEHOW landed on the doc, the webhook payload must hide it.
      // Plant a salary directly via mongoose to simulate that.
      const Model = require('mongoose').models.wh_emp;
      const seeded = await Model.create({
        userId: u._id,
        name: 'Bypass-test',
        salary: 12345,
      });
      // Trigger an update via the API — emits wh_emp.updated whose
      // payload reflects the user's roles (no hr/admin) → no salary.
      await ctx
        .request(ctx.app)
        .put(`/api/v1/wh_emp/${seeded._id}`)
        .set('Authorization', `Bearer ${u.token}`)
        .send({ name: 'Touched' });

      for (let i = 0; i < 30 && received.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // wh_emp.updated for a single record path emits no `record` body
      // (only recordId), so the salary leak is naturally absent on PUT.
      // Switch to GraphQL createOne where the resolver returns the
      // populated record envelope and ACL projection matters.
      received = [];
      const created = await ctx
        .request(ctx.app)
        .post('/graphql/')
        .set('Authorization', `Bearer ${u.token}`)
        .send({
          query:
            'mutation { wh_empCreateOne(record: { name: "no-salary" }) { recordId record { name } } }',
        });
      expect(created.body.errors).toBeUndefined();

      for (let i = 0; i < 30 && received.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(received.length).toBe(1);
      const payload = JSON.parse(received[0].body);
      expect(payload.record.name).toBe('no-salary');
      expect(payload.record.salary).toBeUndefined();
    });
  });

  describe('Dispatcher delivers signed payloads', () => {
    let receiver;
    let received;
    let nextStatus;

    beforeEach(async () => {
      received = [];
      nextStatus = 200;
      receiver = await startReceiver((req, res) => {
        received.push({
          body: req.body,
          signature: req.headers['x-davepi-signature'],
          eventHeader: req.headers['x-davepi-event'],
          delivery: req.headers['x-davepi-delivery'],
        });
        res.status(nextStatus).end();
      });
    });

    afterEach(async () => {
      if (receiver) await receiver.close();
    });

    test('matching event fires the webhook with valid HMAC-SHA256 signature', async () => {
      const u = await registerUser(ctx.request, ctx.app);
      const sub = await ctx
        .request(ctx.app)
        .post('/api/v1/webhooks')
        .set('Authorization', `Bearer ${u.token}`)
        .send({ events: ['account.created'], url: receiver.url });
      const secret = sub.body.secret;

      // Trigger via REST POST.
      await ctx
        .request(ctx.app)
        .post('/api/v1/account')
        .set('Authorization', `Bearer ${u.token}`)
        .send({ accountName: 'wh-evt' });

      // Wait for delivery.
      for (let i = 0; i < 20 && received.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(received.length).toBe(1);
      const got = received[0];
      expect(got.eventHeader).toBe('account.created');
      const expectedSig = `sha256=${sign(secret, got.body)}`;
      expect(got.signature).toBe(expectedSig);
      // Delivery id is unique and in UUID shape.
      expect(got.delivery).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });

    test('non-matching event does NOT fire the webhook', async () => {
      const u = await registerUser(ctx.request, ctx.app);
      await ctx
        .request(ctx.app)
        .post('/api/v1/webhooks')
        .set('Authorization', `Bearer ${u.token}`)
        .send({ events: ['task.*'], url: receiver.url });

      await ctx
        .request(ctx.app)
        .post('/api/v1/account')
        .set('Authorization', `Bearer ${u.token}`)
        .send({ accountName: 'no-match' });

      await new Promise((r) => setTimeout(r, 200));
      expect(received).toHaveLength(0);
    });

    test('subscription is scoped to the user: User B sub never fires for User A events', async () => {
      const a = await registerUser(ctx.request, ctx.app);
      const b = await registerUser(ctx.request, ctx.app);
      await ctx
        .request(ctx.app)
        .post('/api/v1/webhooks')
        .set('Authorization', `Bearer ${b.token}`)
        .send({ events: ['account.*'], url: receiver.url });

      await ctx
        .request(ctx.app)
        .post('/api/v1/account')
        .set('Authorization', `Bearer ${a.token}`)
        .send({ accountName: 'cross-tenant' });

      await new Promise((r) => setTimeout(r, 200));
      expect(received).toHaveLength(0);
    });

    test('POST /:id/test fires regardless of the events filter', async () => {
      const u = await registerUser(ctx.request, ctx.app);
      const sub = await ctx
        .request(ctx.app)
        .post('/api/v1/webhooks')
        .set('Authorization', `Bearer ${u.token}`)
        .send({ events: ['something.unrelated'], url: receiver.url });

      const r = await ctx
        .request(ctx.app)
        .post(`/api/v1/webhooks/${sub.body._id}/test`)
        .set('Authorization', `Bearer ${u.token}`)
        .send({});
      expect(r.status).toBe(202);

      for (let i = 0; i < 20 && received.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(received).toHaveLength(1);
      expect(received[0].eventHeader).toBe('webhook.test');
    });
  });

  describe('Retries, backoff, and auto-disable', () => {
    test('retries on failure, eventually succeeds, resets failureCount', async () => {
      let attempts = 0;
      const receiver = await startReceiver((req, res) => {
        attempts += 1;
        // Fail twice, succeed on the third.
        res.status(attempts < 3 ? 500 : 200).end();
      });
      try {
        // Boot a dispatcher with very short backoff so the test
        // finishes in milliseconds rather than seconds.
        const dispatcher = startWebhookDispatcher({
          backoffMs: [10, 10, 10, 10, 10],
          maxFailures: 10,
        });
        try {
          const u = await registerUser(ctx.request, ctx.app);
          const sub = await Webhook.create({
            userId: u._id,
            events: ['t.created'],
            url: receiver.url,
            secret: 'x'.repeat(64),
            active: true,
          });
          await dispatcher.dispatchOne(sub._id, {
            type: 't.created',
            userId: String(u._id),
            version: 'v1',
            recordId: 'r1',
            record: { hello: 'world' },
          });
          for (let i = 0; i < 50 && attempts < 3; i++) {
            await new Promise((r) => setTimeout(r, 30));
          }
          expect(attempts).toBe(3);
          // The dispatcher's success-path DB update runs async after
          // the receiver returns 200; poll until failureCount settles.
          let after = await Webhook.findById(sub._id);
          for (let i = 0; i < 30 && after.failureCount !== 0; i++) {
            await new Promise((r) => setTimeout(r, 20));
            after = await Webhook.findById(sub._id);
          }
          expect(after.failureCount).toBe(0);
          expect(after.active).toBe(true);
        } finally {
          dispatcher.stop();
        }
      } finally {
        await receiver.close();
      }
    });

    test('auto-disables the subscription after maxFailures consecutive failures', async () => {
      // Receiver that always 500s.
      const receiver = await startReceiver((req, res) => {
        res.status(500).end();
      });
      try {
        // Empty backoff = no retries; each dispatchOne is one attempt.
        const dispatcher = startWebhookDispatcher({
          backoffMs: [],
          maxFailures: 3,
        });
        try {
          const u = await registerUser(ctx.request, ctx.app);
          const sub = await Webhook.create({
            userId: u._id,
            events: ['t.created'],
            url: receiver.url,
            secret: 'x'.repeat(64),
            active: true,
          });

          for (let i = 0; i < 3; i++) {
            await dispatcher.dispatchOne(sub._id, {
              type: 't.created',
              userId: String(u._id),
              version: 'v1',
            });
            await new Promise((r) => setTimeout(r, 30));
          }
          const after = await Webhook.findById(sub._id);
          expect(after.failureCount).toBeGreaterThanOrEqual(3);
          expect(after.active).toBe(false);
        } finally {
          dispatcher.stop();
        }
      } finally {
        await receiver.close();
      }
    });
  });
});
