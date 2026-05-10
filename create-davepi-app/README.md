# create-davepi-app

Scaffold a new [dAvePi](https://github.com/projik/davepi) project in one command.

```bash
npx create-davepi-app my-app
npx create-davepi-app my-crm --template crm
npx create-davepi-app my-tickets --template ticketing
npx create-davepi-app my-blog --template content
```

## Templates

| Template | What you get |
|----------|--------------|
| `blank` | Minimal — one resource (`note`) with full-text search. |
| `crm` | Accounts / contacts / deals (state machine) / activities. Showcases relations, computed fields, file uploads, aggregations. |
| `ticketing` | Tickets with two state machines (status + priority) plus comments. Showcases ACL on a comment field. |
| `content` | Blog / CMS skeleton: articles (editorial workflow), categories, hero image uploads, computed slugs. |
| `b2b-saas` | Multi-tenant SaaS skeleton: orgs / workspaces / invites (state machine) / billing-event ledger with monthly aggregations. |

## What's scaffolded

```
my-app/
├── .env                # random TOKEN_KEY, local Mongo URI
├── .gitignore
├── .mcp.json           # Claude Code wiring, ready to go
├── .cursorrules        # mirrors agent.md for Cursor
├── README.md
├── TEMPLATE.md         # walkthrough of the chosen template's schemas
├── agent.md            # drop-in agent guide
├── docker-compose.yml  # local Mongo
├── index.js            # `require('davepi')`
├── package.json
└── schema/
    └── versions/
        └── v1/
            └── *.js    # the template's resource definitions
```

## Flags

| Flag | Default | Effect |
|------|---------|--------|
| `--template <name>` | `blank` | Pick the starter from the table above. |
| `--no-install` | (run install) | Skip `npm install`. |
| `--davepi-version <range>` | `latest` | Pin a specific dAvePi version in the generated `package.json`. |

## Next steps after scaffolding

```bash
cd my-app
docker compose up -d   # start Mongo
npm start              # http://localhost:5050
```

Then open the project in Claude Code or Cursor — the MCP server is already wired and the agent guide lives at `agent.md`. Ask the agent to add a resource and watch it land via hot-reload.
