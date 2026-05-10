# Blank template

The minimal starter — one resource (`note`) with full-text search, ready to demo CRUD and the admin SPA without telling you what to model.

## Resources

| Resource | Purpose |
|----------|---------|
| `note` | A single text record with `title`, `body`, `pinned`. Both text fields are `searchable` so `__q` works out of the box. |

## Try it

```bash
# After `npx create-davepi-app my-app --template blank`:
cd my-app
npm install
npm start

# In another terminal:
curl -X POST http://localhost:5050/register \
  -H 'Content-Type: application/json' \
  -d '{"first_name":"A","last_name":"B","email":"a@b.com","password":"pw12345!"}'
```

Save the returned `accessToken`, then:

```bash
TOKEN=...
curl -X POST http://localhost:5050/api/v1/note \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Hello","body":"World"}'

curl 'http://localhost:5050/api/v1/note?__q=hello' \
  -H "Authorization: Bearer $TOKEN"
```

## Where to go next

- Add another resource: drop a file in `schema/versions/v1/`. Hot-reload picks it up.
- Wire Claude Code: open the project in your editor, the `.mcp.json` is already configured.
- Generate a typed client: `npx davepi gen-client --out client/davepi.ts`.
