const fs = require('fs');
const os = require('os');
const path = require('path');

const { setupTestApp, registerUser } = require('./helpers');

const ctx = setupTestApp();

// Direct each test run at a fresh uploads directory so cascade-delete
// assertions aren't polluted by other tests' files.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'davepi-uploads-'));
process.env.UPLOADS_DIR = tmpRoot;
process.env.APP_URL = 'http://localhost:4001';
// Force the local driver for these tests.
process.env.STORAGE_DRIVER = 'local';

const documentSchema = {
  path: 'document',
  collection: 'documents',
  version: 'v1',
  fields: [
    { name: 'userId', type: String, required: true },
    { name: 'title', type: String, required: true },
    {
      name: 'attachment',
      type: 'File',
      file: {
        maxBytes: 1024,
        accept: ['text/plain', 'image/*'],
        access: 'public',
      },
    },
    {
      name: 'private_doc',
      type: 'File',
      file: {
        maxBytes: 1024,
        access: 'private',
      },
    },
  ],
};

afterAll(() => {
  // Best-effort cleanup of the temp uploads tree.
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
});

describe('File fields', () => {
  beforeAll(async () => {
    await ctx.app.locals.schemaLoader.loadSchema(documentSchema);
  });

  test('schema with type:File generates a working POST route', async () => {
    const u = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/document')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ title: 'doc1' });
    expect(created.status).toBe(201);
    const id = created.body._id;

    const res = await ctx
      .request(ctx.app)
      .post(`/api/v1/document/${id}/attachment`)
      .set('Authorization', `Bearer ${u.token}`)
      .attach('file', Buffer.from('hello world'), {
        filename: 'hello.txt',
        contentType: 'text/plain',
      });
    expect(res.status).toBe(201);
    expect(res.body.key).toContain('document/');
    expect(res.body.size).toBe('hello world'.length);
    expect(res.body.contentType).toBe('text/plain');
    expect(res.body.originalName).toBe('hello.txt');
    expect(res.body.url).toContain('/_files/');

    // The blob lives on disk under UPLOADS_DIR.
    const onDisk = path.join(tmpRoot, res.body.key);
    expect(fs.existsSync(onDisk)).toBe(true);
    expect(fs.readFileSync(onDisk, 'utf8')).toBe('hello world');
  });

  test('upload exceeding maxBytes returns 400 (multer LIMIT_FILE_SIZE mapped)', async () => {
    const u = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/document')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ title: 'big' });
    const id = created.body._id;

    const big = Buffer.alloc(1024 + 1, 'A');
    const res = await ctx
      .request(ctx.app)
      .post(`/api/v1/document/${id}/attachment`)
      .set('Authorization', `Bearer ${u.token}`)
      .attach('file', big, { filename: 'big.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(res.body.error.message).toMatch(/exceed/i);
  });

  test('upload with disallowed mime type returns 400', async () => {
    const u = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/document')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ title: 'mime' });
    const id = created.body._id;

    const res = await ctx
      .request(ctx.app)
      .post(`/api/v1/document/${id}/attachment`)
      .set('Authorization', `Bearer ${u.token}`)
      .attach('file', Buffer.from('PDF'), {
        filename: 'doc.pdf',
        contentType: 'application/pdf',
      });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/not allowed/i);
  });

  test('GET /:id includes { key, url, size, contentType, originalName } on the file field', async () => {
    const u = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/document')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ title: 'fetch' });
    const id = created.body._id;
    await ctx
      .request(ctx.app)
      .post(`/api/v1/document/${id}/attachment`)
      .set('Authorization', `Bearer ${u.token}`)
      .attach('file', Buffer.from('hi'), { filename: 'hi.txt', contentType: 'text/plain' });

    const got = await ctx
      .request(ctx.app)
      .get(`/api/v1/document/${id}`)
      .set('Authorization', `Bearer ${u.token}`);
    expect(got.status).toBe(200);
    expect(got.body.attachment).toEqual(
      expect.objectContaining({
        key: expect.any(String),
        url: expect.any(String),
        size: 2,
        contentType: 'text/plain',
        originalName: 'hi.txt',
      })
    );
    expect(got.body.attachment.url).toContain('/_files/');
  });

  test('public file URL serves the bytes via /_files/...', async () => {
    const u = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/document')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ title: 'serve' });
    const id = created.body._id;
    const upload = await ctx
      .request(ctx.app)
      .post(`/api/v1/document/${id}/attachment`)
      .set('Authorization', `Bearer ${u.token}`)
      .attach('file', Buffer.from('public-content'), {
        filename: 's.txt',
        contentType: 'text/plain',
      });

    const url = upload.body.url;
    const pathOnly = url.replace('http://localhost:4001', '');
    const fetched = await ctx.request(ctx.app).get(pathOnly);
    expect(fetched.status).toBe(200);
    expect(fetched.text).toBe('public-content');
  });

  test('private file: GET /:id/private_doc returns a 302 to a signed URL; unsigned read is 403', async () => {
    const u = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/document')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ title: 'priv' });
    const id = created.body._id;

    const upload = await ctx
      .request(ctx.app)
      .post(`/api/v1/document/${id}/private_doc`)
      .set('Authorization', `Bearer ${u.token}`)
      .attach('file', Buffer.from('private-content'), {
        filename: 'p.txt',
        contentType: 'text/plain',
      });
    expect(upload.status).toBe(201);
    const key = upload.body.key;

    // Hitting the file path directly without a signature is 403.
    const noSig = await ctx
      .request(ctx.app)
      .get(`/_files/${key}?exp=999&sig=deadbeef`);
    expect(noSig.status).toBe(403);

    // The download endpoint redirects to a signed URL.
    const dl = await ctx
      .request(ctx.app)
      .get(`/api/v1/document/${id}/private_doc`)
      .set('Authorization', `Bearer ${u.token}`)
      .redirects(0);
    expect(dl.status).toBe(302);
    const signedPath = dl.headers.location.replace('http://localhost:4001', '');
    expect(signedPath).toContain('sig=');
    expect(signedPath).toContain('exp=');

    // Following the signed URL serves the content.
    const fetched = await ctx.request(ctx.app).get(signedPath);
    expect(fetched.status).toBe(200);
    expect(fetched.text).toBe('private-content');
  });

  test('uploading a second time replaces the previous blob (cleanup on replace)', async () => {
    const u = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/document')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ title: 'replace' });
    const id = created.body._id;

    const first = await ctx
      .request(ctx.app)
      .post(`/api/v1/document/${id}/attachment`)
      .set('Authorization', `Bearer ${u.token}`)
      .attach('file', Buffer.from('one'), { filename: 'a.txt', contentType: 'text/plain' });
    const firstPath = path.join(tmpRoot, first.body.key);
    expect(fs.existsSync(firstPath)).toBe(true);

    const second = await ctx
      .request(ctx.app)
      .post(`/api/v1/document/${id}/attachment`)
      .set('Authorization', `Bearer ${u.token}`)
      .attach('file', Buffer.from('two'), { filename: 'b.txt', contentType: 'text/plain' });
    expect(second.body.key).not.toBe(first.body.key);
    expect(fs.existsSync(firstPath)).toBe(false); // old blob deleted
  });

  test('DELETE /:id/attachment unlinks the blob and clears the meta', async () => {
    const u = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/document')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ title: 'del-attach' });
    const id = created.body._id;
    const upload = await ctx
      .request(ctx.app)
      .post(`/api/v1/document/${id}/attachment`)
      .set('Authorization', `Bearer ${u.token}`)
      .attach('file', Buffer.from('x'), { filename: 'x.txt', contentType: 'text/plain' });
    const onDisk = path.join(tmpRoot, upload.body.key);
    expect(fs.existsSync(onDisk)).toBe(true);

    const del = await ctx
      .request(ctx.app)
      .delete(`/api/v1/document/${id}/attachment`)
      .set('Authorization', `Bearer ${u.token}`);
    expect(del.status).toBe(204);
    expect(fs.existsSync(onDisk)).toBe(false);

    const got = await ctx
      .request(ctx.app)
      .get(`/api/v1/document/${id}`)
      .set('Authorization', `Bearer ${u.token}`);
    expect(got.body.attachment).toBeFalsy();
  });

  test('DELETE /:id (record) cascades to all File field blobs', async () => {
    const u = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/document')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ title: 'cascade' });
    const id = created.body._id;

    const a = await ctx
      .request(ctx.app)
      .post(`/api/v1/document/${id}/attachment`)
      .set('Authorization', `Bearer ${u.token}`)
      .attach('file', Buffer.from('a'), { filename: 'a.txt', contentType: 'text/plain' });
    const b = await ctx
      .request(ctx.app)
      .post(`/api/v1/document/${id}/private_doc`)
      .set('Authorization', `Bearer ${u.token}`)
      .attach('file', Buffer.from('b'), { filename: 'b.txt', contentType: 'text/plain' });

    const aPath = path.join(tmpRoot, a.body.key);
    const bPath = path.join(tmpRoot, b.body.key);
    expect(fs.existsSync(aPath)).toBe(true);
    expect(fs.existsSync(bPath)).toBe(true);

    const del = await ctx
      .request(ctx.app)
      .delete(`/api/v1/document/${id}`)
      .set('Authorization', `Bearer ${u.token}`);
    expect(del.status).toBe(200);
    expect(fs.existsSync(aPath)).toBe(false);
    expect(fs.existsSync(bPath)).toBe(false);
  });

  test('private file: bare /_files access without sig is rejected (no longer falls through)', async () => {
    const u = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/document')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ title: 'sig-required' });
    const id = created.body._id;
    const upload = await ctx
      .request(ctx.app)
      .post(`/api/v1/document/${id}/private_doc`)
      .set('Authorization', `Bearer ${u.token}`)
      .attach('file', Buffer.from('private-only'), {
        filename: 'p.txt',
        contentType: 'text/plain',
      });
    expect(upload.body.key).toMatch(/^private\//);

    // No exp / sig — must be 403, not a 200 leaking the body.
    const bare = await ctx.request(ctx.app).get(`/_files/${upload.body.key}`);
    expect(bare.status).toBe(403);
    expect(bare.body.error.code).toBe('FORBIDDEN');
  });

  test('public file keys are prefixed `public/` and serve unsigned', async () => {
    const u = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/document')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ title: 'pub' });
    const upload = await ctx
      .request(ctx.app)
      .post(`/api/v1/document/${created.body._id}/attachment`)
      .set('Authorization', `Bearer ${u.token}`)
      .attach('file', Buffer.from('p'), { filename: 'p.txt', contentType: 'text/plain' });
    expect(upload.body.key).toMatch(/^public\//);
  });

  test('client-supplied File field is silently dropped on POST/PUT', async () => {
    const u = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/document')
      .set('Authorization', `Bearer ${u.token}`)
      .send({
        title: 'spoof',
        attachment: {
          key: 'private/owned-by-someone-else/blah',
          size: 9999,
          contentType: 'text/plain',
          originalName: 'evil.txt',
        },
      });
    expect(created.status).toBe(201);
    expect(created.body.attachment).toBeFalsy();

    // PUT update is also blocked.
    const put = await ctx
      .request(ctx.app)
      .put(`/api/v1/document/${created.body._id}`)
      .set('Authorization', `Bearer ${u.token}`)
      .send({ attachment: { key: 'private/another/foo' } });
    expect(put.status).toBe(200);

    const got = await ctx
      .request(ctx.app)
      .get(`/api/v1/document/${created.body._id}`)
      .set('Authorization', `Bearer ${u.token}`);
    expect(got.body.attachment).toBeFalsy();
  });

  test('failed save after a successful put does NOT lose the previous blob', async () => {
    // Plant a previous file on the field, then trigger a save failure
    // by mocking record.save to throw on the next call. The old blob
    // must still exist and the new blob must be removed.
    const u = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/document')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ title: 'durable' });
    const id = created.body._id;
    const first = await ctx
      .request(ctx.app)
      .post(`/api/v1/document/${id}/attachment`)
      .set('Authorization', `Bearer ${u.token}`)
      .attach('file', Buffer.from('old'), { filename: 'a.txt', contentType: 'text/plain' });
    const oldPath = path.join(tmpRoot, first.body.key);
    expect(fs.existsSync(oldPath)).toBe(true);

    // Force the next save() to fail.
    const Doc = require('mongoose').models.documents;
    const orig = Doc.prototype.save;
    Doc.prototype.save = function () { return Promise.reject(new Error('disk full')); };
    try {
      const r = await ctx
        .request(ctx.app)
        .post(`/api/v1/document/${id}/attachment`)
        .set('Authorization', `Bearer ${u.token}`)
        .attach('file', Buffer.from('new'), { filename: 'b.txt', contentType: 'text/plain' });
      expect(r.status).toBe(500);
    } finally {
      Doc.prototype.save = orig;
    }

    // Old blob still there, record still references the old key.
    expect(fs.existsSync(oldPath)).toBe(true);
    const got = await ctx
      .request(ctx.app)
      .get(`/api/v1/document/${id}`)
      .set('Authorization', `Bearer ${u.token}`);
    expect(got.body.attachment.key).toBe(first.body.key);
  });

  test('Swagger spec lists the file field upload/get/delete paths', async () => {
    const swagger = await ctx.request(ctx.app).get('/api-docs/swagger.json');
    expect(swagger.status).toBe(200);
    const upPath = swagger.body.paths['/api/v1/document/{id}/attachment'];
    expect(upPath).toBeDefined();
    expect(upPath.post.consumes).toContain('multipart/form-data');
    expect(upPath.post.parameters.find((p) => p.name === 'file').type).toBe('file');
    expect(upPath.get).toBeDefined();
    expect(upPath.delete).toBeDefined();
  });

  test('user isolation: User B cannot upload to User A record', async () => {
    const a = await registerUser(ctx.request, ctx.app);
    const b = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/document')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ title: 'isol' });
    const id = created.body._id;

    const res = await ctx
      .request(ctx.app)
      .post(`/api/v1/document/${id}/attachment`)
      .set('Authorization', `Bearer ${b.token}`)
      .attach('file', Buffer.from('hack'), {
        filename: 'h.txt',
        contentType: 'text/plain',
      });
    expect(res.status).toBe(404);
  });
});
