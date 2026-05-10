# Content template

A blog / CMS skeleton with editorial workflow, slug computation, hero image upload, and category aggregations.

## Resources

| Resource | Purpose |
|----------|---------|
| `article` | The post. `slug` is computed from `title`. `status` flows `draft → review → published → archived` (any state can return to `draft`). `heroImage` is a public file ≤5MB. `publishedAt` is set on the client side when transitioning to `published` (see the example below). |
| `category` | Taxonomy. `slug` is computed from `name`. `name` is unique. Relates back to articles via `category.articles` (hasMany). |

## Aggregations

- `article.byStatus` — count per status (draft / review / published / archived). Cached 60s.
- `article.byCategory` — published articles grouped by `categoryId`. Cached 60s.

## Worked example

```bash
TOKEN=$(curl -s -X POST http://localhost:5050/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"a@b.com","password":"pw12345!"}' | jq -r .accessToken)

# Create a category
CAT=$(curl -s -X POST http://localhost:5050/api/v1/category \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Engineering","description":"Behind the scenes"}' | jq -r ._id)

# Create an article — initial status = "draft"
A=$(curl -s -X POST http://localhost:5050/api/v1/article \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"title\":\"How we ship\",\"body\":\"Once a week.\",\"categoryId\":\"$CAT\",\"tags\":[\"process\"]}")
echo "$A" | jq '{_id, slug, status, availableTransitions}'

ID=$(echo "$A" | jq -r ._id)

# draft → review
curl -s -X PUT "http://localhost:5050/api/v1/article/$ID" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"review"}'

# review → published, stamping publishedAt at the same time
curl -s -X PUT "http://localhost:5050/api/v1/article/$ID" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"status\":\"published\",\"publishedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"

curl "http://localhost:5050/api/v1/article/$ID" \
  -H "Authorization: Bearer $TOKEN" | jq '{title, slug, status, publishedAt}'

# Upload a hero image
curl -X POST "http://localhost:5050/api/v1/article/$ID/heroImage" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@./hero.jpg"
```

## With Claude Code

> Add a `readingTimeMinutes` computed field to article: estimated reading time based on `body` length at 200 words per minute.
