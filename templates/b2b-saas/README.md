# B2B SaaS template

Multi-tenant SaaS skeleton: orgs, workspaces, invitations with a state machine, and a billing-event log with monthly aggregations. The patterns here scale to a real product — invite flow, plan/seat tracking, billing-event audit, computed slug.

## Resources

| Resource | Purpose |
|----------|---------|
| `org` | The customer entity. `slug` is computed from `name`. `plan` and `seats` track the subscription. Has `workspaces` (hasMany) and `invites` (hasMany). |
| `workspace` | A scoped area inside an org. Connects via `org` (belongsTo `orgId`). |
| `invite` | Pending invitations. `status` flows `pending → accepted / declined / revoked / expired`. `expired` can re-enter `pending` if the org reissues. |
| `billingEvent` | Append-only ledger (upgrade / downgrade / invoice / refund / usage) referencing an org. Aggregations: `byOrg` (total per org), `monthlyRecurring` (per-month totals). |

## Worked example

```bash
TOKEN=$(curl -s -X POST http://localhost:5050/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"a@b.com","password":"pw12345!"}' | jq -r .accessToken)

# Create an org
ORG=$(curl -s -X POST http://localhost:5050/api/v1/org \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Acme Co","plan":"starter","seats":10}' | jq -r ._id)

# Add a workspace inside it
curl -s -X POST http://localhost:5050/api/v1/workspace \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"orgId\":\"$ORG\",\"name\":\"Engineering\"}"

# Invite someone — initial status = "pending"
INV=$(curl -s -X POST http://localhost:5050/api/v1/invite \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"orgId\":\"$ORG\",\"email\":\"jane@acme.com\",\"role\":\"admin\"}" | jq -r ._id)

# Accept
curl -s -X PUT "http://localhost:5050/api/v1/invite/$INV" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"status\":\"accepted\",\"acceptedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"

# Log a plan upgrade
curl -s -X POST http://localhost:5050/api/v1/billingEvent \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"orgId\":\"$ORG\",\"kind\":\"upgrade\",\"amount\":99,\"externalRef\":\"ch_abc\"}"

# Aggregations
curl http://localhost:5050/api/v1/billingEvent/aggregations/byOrg \
  -H "Authorization: Bearer $TOKEN" | jq
```

## With Claude Code

> Add a `member` resource that joins users to orgs (with role: 'owner' | 'admin' | 'member'), and a `members` hasMany relation on org.

## Pair with Idempotency-Key

The invite-create endpoint is the obvious place — sending the same key + body twice returns the original invite instead of creating a duplicate. See [Idempotency keys](https://docs.davepi.dev/features/idempotency/).
