# Ticketing template

A help-desk skeleton with **two state machines on one schema** (status + priority), full-text search, an internal-only comment field gated by ACL, and aggregations for triage views.

## Resources

| Resource | Purpose |
|----------|---------|
| `ticket` | The work item. `status` flows `open → in_progress → resolved → closed` (with reopen). `priority` flows `low ↔ normal ↔ high ↔ urgent` (no skipping levels). |
| `comment` | Replies on a ticket. `internal` is a flag gated by field-level ACL (`read: ['staff','admin']`) — non-staff callers don't see the flag. Note: this hides the **flag**, not the comment body. To make staff-only notes truly invisible to customers (no body, no metadata), model them as a separate resource so they never appear in `list` queries. |

## Aggregations

- `ticket.byStatus` — counts grouped by status. Cached 15s.
- `ticket.urgentOpen` — currently-burning tickets, newest first. Capped at 50.

## Worked example

```bash
TOKEN=$(curl -s -X POST http://localhost:5050/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"a@b.com","password":"pw12345!"}' | jq -r .accessToken)

# Create a ticket — initial status = "open", initial priority = "normal"
T=$(curl -s -X POST http://localhost:5050/api/v1/ticket \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Login broken","body":"500 on /login","reporterId":"u1"}' | jq -r ._id)

# Take it
curl -s -X PUT "http://localhost:5050/api/v1/ticket/$T" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"in_progress","assigneeId":"u2"}'

# Try to skip stages — rejected with 400 INVALID_TRANSITION
curl -s -X PUT "http://localhost:5050/api/v1/ticket/$T" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"priority":"urgent"}'    # normal → urgent isn't allowed; must go via high

# Triage view
curl http://localhost:5050/api/v1/ticket/aggregations/byStatus \
  -H "Authorization: Bearer $TOKEN" | jq
```

## With Claude Code

> Add an SLA computed field to ticket: number of minutes since `createdAt` if status isn't `resolved`/`closed`, else 0.
