# CRM template

A minimal sales CRM. Demonstrates relations, state machines, computed fields, full-text search, file uploads, and aggregations — all features you'll learn by reading the schema files.

## Resources

| Resource | Purpose |
|----------|---------|
| `account` | Companies you sell to. `name` and `description` are full-text searchable. Carries an optional logo (image, ≤2MB, public). Has `contacts` (hasMany), `deals` (hasMany), and `primaryContact` (hasOne where `isPrimary: true`). |
| `contact` | People at an account. `parentAccountId` joins to `account`. `fullName` is a computed field. |
| `deal` | Opportunity in flight. `stage` is a state machine: `lead → qualified → proposal → negotiation → won` (or `lost` from any earlier stage; `lost` can be re-opened). |
| `activity` | Touchpoints (call / email / meeting / note). Optionally tied to a contact or a deal. |

## Aggregations

- `deal.pipelineByStage` — total amount + count grouped by deal stage. Cached 30s.
- `deal.wonByMonth` — won-deal totals grouped by close month. Cached 60s.

## Worked example

```bash
TOKEN=$(curl -s -X POST http://localhost:5050/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"a@b.com","password":"pw12345!"}' | jq -r .accessToken)

# 1. Create an account
ACCT=$(curl -s -X POST http://localhost:5050/api/v1/account \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Acme","industry":"manufacturing","employees":250}' | jq -r ._id)

# 2. Add a contact
curl -s -X POST http://localhost:5050/api/v1/contact \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"parentAccountId\":\"$ACCT\",\"firstName\":\"Jane\",\"lastName\":\"Doe\",\"email\":\"jane@acme.com\",\"isPrimary\":true}"

# 3. Create a deal — initial state stamped to "lead"
DEAL=$(curl -s -X POST http://localhost:5050/api/v1/deal \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"parentAccountId\":\"$ACCT\",\"title\":\"Q1 expansion\",\"amount\":50000}" | jq -r ._id)

# 4. Move it forward
curl -s -X PUT "http://localhost:5050/api/v1/deal/$DEAL" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"stage":"qualified"}'

# 5. Get the deal with its account populated
curl "http://localhost:5050/api/v1/deal/$DEAL?__include=account" \
  -H "Authorization: Bearer $TOKEN" | jq

# 6. Pipeline view
curl http://localhost:5050/api/v1/deal/aggregations/pipelineByStage \
  -H "Authorization: Bearer $TOKEN" | jq
```

## With Claude Code

Open the project, the `.mcp.json` is already configured. Try:

> Add a `lostReason` field to deal that's only populated when stage is `lost`, and an aggregation that groups `lost` deals by reason.
