const fs = require('fs');
const os = require('os');
const path = require('path');
const { setupTestApp, registerUser } = require('./helpers');
const { scaffold, TEMPLATES } = require('../create-davepi-app/bin/index.js');

describe('create-davepi-app: scaffolder', () => {
  let workdir;
  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'davepi-scaffold-'));
  });
  afterEach(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  test('exports the four supported templates', () => {
    expect(TEMPLATES).toEqual(['blank', 'crm', 'ticketing', 'content']);
  });

  test('scaffolds a blank project with the expected file tree', () => {
    const target = path.join(workdir, 'demo');
    scaffold({ name: 'demo', template: 'blank', install: false, davepiVersion: 'latest' });
    // The CLI uses path.resolve(name); since the test cwd isn't
    // workdir, the project lands relative to the test process.
    // Use the same resolution the CLI does.
    const resolved = path.resolve('demo');
    expect(fs.existsSync(path.join(resolved, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(resolved, '.env'))).toBe(true);
    expect(fs.existsSync(path.join(resolved, '.gitignore'))).toBe(true);
    expect(fs.existsSync(path.join(resolved, '.mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(resolved, 'agent.md'))).toBe(true);
    expect(fs.existsSync(path.join(resolved, '.cursorrules'))).toBe(true);
    expect(fs.existsSync(path.join(resolved, 'docker-compose.yml'))).toBe(true);
    expect(fs.existsSync(path.join(resolved, 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(resolved, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(resolved, 'TEMPLATE.md'))).toBe(true);
    expect(
      fs.existsSync(path.join(resolved, 'schema', 'versions', 'v1', 'note.js'))
    ).toBe(true);
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  test('package.json is well-formed and pins davepi', () => {
    scaffold({
      name: 'demo2',
      template: 'crm',
      install: false,
      davepiVersion: '^1.2.3',
    });
    const resolved = path.resolve('demo2');
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(resolved, 'package.json'), 'utf8')
      );
      expect(pkg.name).toBe('demo2');
      expect(pkg.dependencies.davepi).toBe('^1.2.3');
      expect(pkg.scripts.start).toBe('node index.js');
      expect(pkg.scripts['gen-client']).toMatch(/davepi gen-client/);
    } finally {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });

  test('each template scaffolds without error', () => {
    for (const tpl of TEMPLATES) {
      const dirName = `t-${tpl}`;
      scaffold({ name: dirName, template: tpl, install: false, davepiVersion: 'latest' });
      const resolved = path.resolve(dirName);
      try {
        // Each template has at least one schema file
        const files = fs
          .readdirSync(path.join(resolved, 'schema', 'versions', 'v1'))
          .filter((f) => f.endsWith('.js'));
        expect(files.length).toBeGreaterThan(0);
      } finally {
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    }
  });

  test('rejects an unknown template name', () => {
    expect(() =>
      scaffold({ name: 'demo3', template: 'made-up', install: false })
    ).toThrow(/Unknown template/);
    fs.rmSync(path.resolve('demo3'), { recursive: true, force: true });
  });

  test('refuses to scaffold into a non-empty existing directory', () => {
    const target = path.resolve('demo4');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'PRECIOUS.txt'), 'do not delete');
    try {
      expect(() =>
        scaffold({ name: 'demo4', template: 'blank', install: false })
      ).toThrow(/already exists and is not empty/);
      // The pre-existing file is untouched.
      expect(fs.readFileSync(path.join(target, 'PRECIOUS.txt'), 'utf8')).toBe(
        'do not delete'
      );
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  test('.env carries a randomised TOKEN_KEY (NOT the dev default)', () => {
    scaffold({ name: 'demo5', template: 'blank', install: false });
    const resolved = path.resolve('demo5');
    try {
      const env = fs.readFileSync(path.join(resolved, '.env'), 'utf8');
      const m = env.match(/TOKEN_KEY=([0-9a-f]+)/);
      expect(m).not.toBeNull();
      expect(m[1].length).toBeGreaterThan(48); // 32 random bytes hex-encoded
    } finally {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });
});

describe('templates: each one boots and exercises its surface', () => {
  // Load every template's schemas through the live schema loader
  // and prove the auto-generated REST surface works. The blank
  // template is the smoke test; the others walk through a
  // representative call that exercises a feature unique to that
  // template (state machines, computed, aggregations, etc.).
  const ctx = setupTestApp({ cleanCollections: false });
  const loaded = [];

  beforeAll(async () => {
    for (const tpl of ['blank', 'crm', 'ticketing', 'content']) {
      const tplDir = path.resolve(
        __dirname,
        '..',
        'templates',
        tpl,
        'schema',
        'versions',
        'v1'
      );
      for (const file of fs.readdirSync(tplDir)) {
        if (!file.endsWith('.js')) continue;
        delete require.cache[require.resolve(path.join(tplDir, file))];
        const schemaModule = require(path.join(tplDir, file));
        schemaModule.version = 'v1';
        await ctx.app.locals.schemaLoader.loadSchema(schemaModule, {
          deferGraphqlRebuild: true,
        });
        loaded.push(`v1/${schemaModule.path}`);
      }
    }
    await ctx.app.locals.schemaLoader.rebuildGraphQL();
  });

  afterAll(async () => {
    if (ctx.app.locals.webhookDispatcher) {
      ctx.app.locals.webhookDispatcher.stop();
    }
    await new Promise((r) => setImmediate(r));
    for (const key of loaded) {
      try { await ctx.app.locals.schemaLoader.unloadSchema(key); }
      catch (_) {}
    }
  });

  test('blank: POST/GET note round-trip + full-text search', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    await ctx.request(ctx.app)
      .post('/api/v1/note')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'urgent thing', body: 'must do today' });
    await ctx.request(ctx.app)
      .post('/api/v1/note')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'unrelated', body: 'nothing' });
    const list = await ctx.request(ctx.app)
      .get('/api/v1/note?__q=urgent')
      .set('Authorization', `Bearer ${user.token}`);
    expect(list.status).toBe(200);
    const titles = list.body.results.map((r) => r.title);
    expect(titles).toContain('urgent thing');
  });

  test('crm: deal stage state machine rejects skipping stages', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const acct = await ctx.request(ctx.app)
      .post('/api/v1/account')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ name: 'Acme' });
    const deal = await ctx.request(ctx.app)
      .post('/api/v1/deal')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ parentAccountId: acct.body._id, title: 'Q1', amount: 1000 });
    expect(deal.body.stage).toBe('lead');
    expect(deal.body.availableTransitions.stage).toEqual(['qualified', 'lost']);

    // lead → won is undeclared → 400 INVALID_TRANSITION
    const bad = await ctx.request(ctx.app)
      .put(`/api/v1/deal/${deal.body._id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ stage: 'won' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_TRANSITION');

    // lead → qualified is allowed
    const ok = await ctx.request(ctx.app)
      .put(`/api/v1/deal/${deal.body._id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ stage: 'qualified' });
    expect(ok.status).toBe(200);
  });

  test('crm: contact.fullName computed field', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const acct = await ctx.request(ctx.app)
      .post('/api/v1/account')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ name: 'Acme' });
    const c = await ctx.request(ctx.app)
      .post('/api/v1/contact')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        parentAccountId: acct.body._id,
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
    expect(c.body.fullName).toBe('Ada Lovelace');
  });

  test('crm: pipelineByStage aggregation', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const acct = await ctx.request(ctx.app)
      .post('/api/v1/account')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ name: 'Acme' });
    for (const amount of [100, 200, 300]) {
      await ctx.request(ctx.app)
        .post('/api/v1/deal')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ parentAccountId: acct.body._id, title: 't', amount });
    }
    const pipe = await ctx.request(ctx.app)
      .get('/api/v1/deal/aggregations/pipelineByStage')
      .set('Authorization', `Bearer ${user.token}`);
    expect(pipe.status).toBe(200);
    const lead = pipe.body.find((row) => row._id === 'lead');
    expect(lead).toBeDefined();
    expect(lead.total).toBe(600);
    expect(lead.count).toBe(3);
  });

  test('ticketing: priority state machine cannot skip levels', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const t = await ctx.request(ctx.app)
      .post('/api/v1/ticket')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'broken', body: 'help', reporterId: 'u' });
    expect(t.body.priority).toBe('normal');
    // normal → urgent is not declared (must go via high)
    const bad = await ctx.request(ctx.app)
      .put(`/api/v1/ticket/${t.body._id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ priority: 'urgent' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_TRANSITION');
  });

  test('content: article slug is computed from title; state machine governs status', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const a = await ctx.request(ctx.app)
      .post('/api/v1/article')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'How We Ship', body: 'often' });
    expect(a.body.slug).toBe('how-we-ship');
    expect(a.body.status).toBe('draft');
    expect(a.body.availableTransitions.status).toEqual(['review', 'archived']);

    // draft → review → published, with publishedAt stamped by the
    // client on the same PUT (see TEMPLATE.md).
    await ctx.request(ctx.app)
      .put(`/api/v1/article/${a.body._id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ status: 'review' });
    const publishedAt = new Date().toISOString();
    await ctx.request(ctx.app)
      .put(`/api/v1/article/${a.body._id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ status: 'published', publishedAt });

    const fetched = await ctx.request(ctx.app)
      .get(`/api/v1/article/${a.body._id}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(fetched.body.status).toBe('published');
    expect(fetched.body.publishedAt).toBe(publishedAt);
  });
});
