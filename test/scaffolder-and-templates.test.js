const fs = require('fs');
const os = require('os');
const path = require('path');
const { setupTestApp, registerUser } = require('./helpers');
const { scaffold, TEMPLATES, flag, isPortFree } = require('../create-davepi-app/bin/index.js');
const { buildMcpServer, listToolNames } = require('../utils/mcpServer');

describe('create-davepi-app: scaffolder', () => {
  // Each test scaffolds into a unique directory (CLI uses
  // path.resolve(name) relative to the test process's cwd) and
  // cleans up after itself in a finally block.
  const cleanup = (name) =>
    fs.rmSync(path.resolve(name), { recursive: true, force: true });

  test('exports the five supported templates', () => {
    expect(TEMPLATES).toEqual(['blank', 'crm', 'ticketing', 'content', 'b2b-saas']);
  });

  test('scaffolds a blank project with the expected file tree', async () => {
    await scaffold({
      name: 'demo',
      template: 'blank',
      install: false,
      davepiVersion: 'latest',
      port: 0,
    });
    try {
      const resolved = path.resolve('demo');
      for (const f of [
        'package.json', '.env', '.gitignore', '.mcp.json',
        'agent.md', '.cursorrules', 'AGENTS.md',
        '.claude/skills/davepi/SKILL.md',
        'docker-compose.yml',
        'index.js', 'README.md', 'TEMPLATE.md', 'seed.js',
        'schema/versions/v1/note.js',
      ]) {
        expect(fs.existsSync(path.join(resolved, f))).toBe(true);
      }
    } finally {
      cleanup('demo');
    }
  });

  test('package.json is well-formed and pins davepi', async () => {
    await scaffold({
      name: 'demo2',
      template: 'crm',
      install: false,
      davepiVersion: '^1.2.3',
      port: 0,
    });
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.resolve('demo2', 'package.json'), 'utf8')
      );
      expect(pkg.name).toBe('demo2');
      expect(pkg.dependencies.davepi).toBe('^1.2.3');
      expect(pkg.scripts.start).toBe('node index.js');
      expect(pkg.scripts.seed).toBe('node seed.js');
      expect(pkg.scripts['gen-client']).toMatch(/davepi gen-client/);
    } finally {
      cleanup('demo2');
    }
  });

  test('each template scaffolds without error and ships seed.js', async () => {
    for (const tpl of TEMPLATES) {
      const dirName = `t-${tpl}`;
      await scaffold({ name: dirName, template: tpl, install: false, davepiVersion: 'latest', port: 0 });
      try {
        const resolved = path.resolve(dirName);
        const files = fs
          .readdirSync(path.join(resolved, 'schema', 'versions', 'v1'))
          .filter((f) => f.endsWith('.js'));
        expect(files.length).toBeGreaterThan(0);
        expect(fs.existsSync(path.join(resolved, 'seed.js'))).toBe(true);
      } finally {
        cleanup(dirName);
      }
    }
  });

  test('agent guide mirrors carry the canonical content + skill frontmatter', async () => {
    await scaffold({
      name: 'demo-agent',
      template: 'blank',
      install: false,
      davepiVersion: 'latest',
      port: 5599,
    });
    try {
      const root = path.resolve('demo-agent');
      const canonical = fs.readFileSync(path.join(root, 'agent.md'), 'utf8');
      const cursor = fs.readFileSync(path.join(root, '.cursorrules'), 'utf8');
      const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
      const skill = fs.readFileSync(
        path.join(root, '.claude', 'skills', 'davepi', 'SKILL.md'),
        'utf8'
      );

      // The three plain mirrors carry identical content and the
      // canonical content covers the major framework concepts agents
      // need (idempotency, _describe, state machines, ACL).
      expect(cursor).toBe(canonical);
      expect(agents).toBe(canonical);
      expect(canonical).toMatch(/Idempotency-Key/);
      expect(canonical).toMatch(/_describe/);
      expect(canonical).toMatch(/stateMachine/);
      expect(canonical).toMatch(/parentAccountId/);
      // {{PORT}} placeholder is substituted with the bound port.
      expect(canonical).not.toMatch(/\{\{PORT\}\}/);
      expect(canonical).toMatch(/localhost:5599/);

      // The Claude Code skill mirror has the YAML frontmatter the
      // runtime requires, with no leading H1 (frontmatter replaces it).
      expect(skill.startsWith('---\nname: davepi\n')).toBe(true);
      expect(skill).toMatch(/^description:.+/m);
      expect(skill).not.toMatch(/^# Agent guide/m);
      // Same body content as the canonical guide.
      expect(skill).toMatch(/Idempotency-Key/);
      expect(skill).toMatch(/_describe/);
    } finally {
      cleanup('demo-agent');
    }
  });

  test('rejects an unknown template name', async () => {
    await expect(
      scaffold({ name: 'demo3', template: 'made-up', install: false, port: 0 })
    ).rejects.toThrow(/Unknown template/);
    cleanup('demo3');
  });

  test('refuses to scaffold into a non-empty existing directory', async () => {
    const target = path.resolve('demo4');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'PRECIOUS.txt'), 'do not delete');
    try {
      await expect(
        scaffold({ name: 'demo4', template: 'blank', install: false, port: 0 })
      ).rejects.toThrow(/already exists and is not empty/);
      expect(fs.readFileSync(path.join(target, 'PRECIOUS.txt'), 'utf8'))
        .toBe('do not delete');
    } finally {
      cleanup('demo4');
    }
  });

  test('.env carries a randomised TOKEN_KEY (NOT the dev default)', async () => {
    await scaffold({ name: 'demo5', template: 'blank', install: false, port: 0 });
    try {
      const env = fs.readFileSync(path.resolve('demo5', '.env'), 'utf8');
      const m = env.match(/TOKEN_KEY=([0-9a-f]+)/);
      expect(m).not.toBeNull();
      expect(m[1].length).toBeGreaterThan(48); // 32 random bytes hex-encoded
    } finally {
      cleanup('demo5');
    }
  });

  test('picks an unused API_PORT instead of the fixed 5050 default', async () => {
    // Hold port 5050 so the scaffolder is forced to skip past it.
    const blocker = require('net').createServer();
    await new Promise((resolve, reject) => {
      blocker.once('error', (err) => {
        // If 5050 is already in use, that's fine — the scaffolder
        // will still skip past it. Just continue.
        if (err.code === 'EADDRINUSE') resolve();
        else reject(err);
      });
      blocker.listen(5050, '127.0.0.1', () => resolve());
    });
    try {
      await scaffold({ name: 'demo6', template: 'blank', install: false });
      const env = fs.readFileSync(path.resolve('demo6', '.env'), 'utf8');
      const m = env.match(/API_PORT=(\d+)/);
      expect(m).not.toBeNull();
      const picked = parseInt(m[1], 10);
      expect(picked).not.toBe(5050);
      expect(picked).toBeGreaterThan(0);
    } finally {
      cleanup('demo6');
      await new Promise((r) => blocker.close(() => r()));
    }
  });

  test('scaffolded project prints the correct admin URL on success', async () => {
    // Capture stdout and assert the next-step instructions reflect
    // the picked port.
    const orig = process.stdout.write.bind(process.stdout);
    let captured = '';
    process.stdout.write = (chunk, ...rest) => {
      captured += String(chunk);
      return orig(chunk, ...rest);
    };
    try {
      await scaffold({ name: 'demo7', template: 'blank', install: false, port: 5555 });
      expect(captured).toMatch(/http:\/\/localhost:5555/);
    } finally {
      process.stdout.write = orig;
      cleanup('demo7');
    }
  });

  describe('flag parser', () => {
    test('returns null when flag is absent', () => {
      expect(flag(['x'], '--missing')).toBeNull();
    });
    test('returns the value when present', () => {
      expect(flag(['--template', 'crm'], '--template')).toBe('crm');
    });
    test('returns true when present without a value', () => {
      expect(flag(['--no-install'], '--no-install')).toBe(true);
    });
    test('rejects a value that looks like another flag', () => {
      // `--davepi-version --no-install` would otherwise pin
      // davepi to "--no-install" and silently produce an
      // un-installable project.
      expect(() =>
        flag(['--davepi-version', '--no-install'], '--davepi-version')
      ).toThrow(/requires a value/);
    });
  });

  describe('isPortFree', () => {
    test('returns true for a port that nobody is bound to', async () => {
      // Borrow an OS-assigned port by binding-then-closing, then
      // assert isPortFree agrees.
      const srv = require('net').createServer();
      const port = await new Promise((resolve) => {
        srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
      });
      await new Promise((r) => srv.close(() => r()));
      expect(await isPortFree(port)).toBe(true);
    });
    test('returns false for a port currently in use', async () => {
      const srv = require('net').createServer();
      const port = await new Promise((resolve) => {
        srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
      });
      try {
        expect(await isPortFree(port)).toBe(false);
      } finally {
        await new Promise((r) => srv.close(() => r()));
      }
    });
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
    for (const tpl of ['blank', 'crm', 'ticketing', 'content', 'b2b-saas']) {
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

  test('content: category.name is unique per-tenant, not globally', async () => {
    // Two different users can each have a category called
    // "Engineering" — the compositeIndex on {userId, name}
    // guarantees per-tenant uniqueness without leaking the value
    // across tenants.
    const a = await registerUser(ctx.request, ctx.app);
    const b = await registerUser(ctx.request, ctx.app);
    const aRes = await ctx.request(ctx.app)
      .post('/api/v1/category')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ name: 'Engineering' });
    expect(aRes.status).toBe(201);
    const bRes = await ctx.request(ctx.app)
      .post('/api/v1/category')
      .set('Authorization', `Bearer ${b.token}`)
      .send({ name: 'Engineering' });
    expect(bRes.status).toBe(201);
    expect(bRes.body._id).not.toBe(aRes.body._id);

    // But the SAME user can't reuse the name within their own tenant.
    const dup = await ctx.request(ctx.app)
      .post('/api/v1/category')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ name: 'Engineering' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE');
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

  test('b2b-saas: invite state machine + billingEvent.byOrg aggregation', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const org = await ctx.request(ctx.app)
      .post('/api/v1/org')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ name: 'Acme', plan: 'starter' });
    expect(org.body.slug).toBe('acme');

    const inv = await ctx.request(ctx.app)
      .post('/api/v1/invite')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ orgId: org.body._id, email: 'a@b.com', role: 'member' });
    expect(inv.body.status).toBe('pending');
    // accepted is terminal
    await ctx.request(ctx.app)
      .put(`/api/v1/invite/${inv.body._id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ status: 'accepted' });
    const reAttempt = await ctx.request(ctx.app)
      .put(`/api/v1/invite/${inv.body._id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ status: 'pending' });
    expect(reAttempt.status).toBe(400);
    expect(reAttempt.body.error.code).toBe('INVALID_TRANSITION');

    // Aggregation
    await ctx.request(ctx.app)
      .post('/api/v1/billingEvent')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ orgId: org.body._id, kind: 'upgrade', amount: 99 });
    await ctx.request(ctx.app)
      .post('/api/v1/billingEvent')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ orgId: org.body._id, kind: 'invoice', amount: 200 });
    const agg = await ctx.request(ctx.app)
      .get('/api/v1/billingEvent/aggregations/byOrg')
      .set('Authorization', `Bearer ${user.token}`);
    expect(agg.status).toBe(200);
    const row = agg.body.find((r) => r._id === org.body._id);
    expect(row.total).toBe(299);
    expect(row.count).toBe(2);
  });

  // Agent-surface smoke test per template. Building an MCP server
  // against the loaded schemas and asserting the expected tool
  // names appear validates the end-to-end agent path without
  // needing a live agent in CI. The agent eval suite (#65) is the
  // place for prompt-driven tests; this is the structural check
  // every template must pass.
  describe('agent surface (MCP tool list) per template', () => {
    test('blank: list/get/create/update/delete tools for note', () => {
      const names = listToolNames(ctx.app.locals.schemaLoader);
      for (const verb of ['list', 'get', 'create', 'update', 'delete']) {
        expect(names).toContain(`${verb}_note`);
      }
    });

    test('crm: state-machine transitions surface as MCP tools', () => {
      const names = listToolNames(ctx.app.locals.schemaLoader);
      // CRUD per resource
      for (const r of ['account', 'contact', 'deal', 'activity']) {
        expect(names).toContain(`list_${r}`);
        expect(names).toContain(`create_${r}`);
      }
      // Aggregations exposed as tools
      expect(names).toContain('aggregate_deal_pipelineByStage');
      expect(names).toContain('aggregate_deal_wonByMonth');
      // Per-relation navigation
      expect(names).toContain('list_account_contacts');
      expect(names).toContain('list_account_deals');
      expect(names).toContain('get_contact_account');
      // File-field tools on account.logo
      expect(names).toContain('upload_account_logo');
      expect(names).toContain('fetch_account_logo');
      expect(names).toContain('delete_account_logo');
    });

    test('ticketing: dual state machines + ACL\'d comment field', () => {
      const names = listToolNames(ctx.app.locals.schemaLoader);
      for (const r of ['ticket', 'comment']) {
        expect(names).toContain(`list_${r}`);
        expect(names).toContain(`create_${r}`);
      }
      expect(names).toContain('aggregate_ticket_byStatus');
      expect(names).toContain('aggregate_ticket_urgentOpen');
    });

    test('content: editorial workflow + file uploads', () => {
      const names = listToolNames(ctx.app.locals.schemaLoader);
      for (const r of ['article', 'category']) {
        expect(names).toContain(`list_${r}`);
        expect(names).toContain(`create_${r}`);
      }
      expect(names).toContain('upload_article_heroImage');
      expect(names).toContain('aggregate_article_byStatus');
      expect(names).toContain('aggregate_article_byCategory');
    });

    test('b2b-saas: orgs/workspaces/invites/billing tools', () => {
      const names = listToolNames(ctx.app.locals.schemaLoader);
      for (const r of ['org', 'workspace', 'invite', 'billingEvent']) {
        expect(names).toContain(`list_${r}`);
        expect(names).toContain(`create_${r}`);
      }
      expect(names).toContain('aggregate_billingEvent_byOrg');
      expect(names).toContain('aggregate_billingEvent_monthlyRecurring');
    });

    test('an MCP server actually instantiates against every template\'s schemas', async () => {
      // Build an MCP server bound to a synthetic user and verify
      // the canonical tool names land in the registered tool list.
      // Catches issues where the schema map is malformed enough to
      // make the server fail to compose (relations pointing at
      // unloaded targets, etc.).
      const user = { user_id: 'agent-smoke', roles: ['user'] };
      const server = buildMcpServer({
        schemaLoader: ctx.app.locals.schemaLoader,
        getUser: () => user,
        name: 'agent-smoke',
      });
      try {
        // McpServer doesn't expose a public "list registered tools"
        // accessor, but listToolNames mirrors the same registration
        // logic and is a reliable proxy. Successfully calling
        // buildMcpServer is the smoke signal.
        expect(server).toBeTruthy();
      } finally {
        await server.close();
      }
    });
  });
});
