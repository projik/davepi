---
title: Tutorial series — six demos
description: Six step-by-step tutorials, from a single-collection habit tracker through to a multi-tenant booking platform that takes actions, plus an internal IT helpdesk where the agent reaches beyond the database.
---

A series of build-along tutorials that take you from a single-collection
"hello world" through to a multi-tenant booking platform where the agent
takes actions on your behalf, plus a final one where the agent reaches
*outside* dAvePi entirely. Every tutorial follows the same arc:

1. Scaffold a new project with `npx create-davepi-app`.
2. Ask the agent to make schema changes (add fields, add a collection, wire up a hook).
3. Spin up the admin SPA.
4. Make a UI tweak or seed data through the UI.
5. Attach the [`@davepi/agent`](/surfaces/agent/) package to Slack.
6. Ask the agent questions about the seeded data — get answers, tables, charts.

The escalation between tutorials is in *what* the agent does and *who*
it does it for, not in how much code you write.

## The six

| #  | Tutorial                                                                   | New capability                                                    | Time |
| -- | -------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---- |
| 1  | [Habit tracker](/tutorials/habit-tracker/)                                 | The core loop end-to-end                                          | ~15m |
| 2  | [Customer support inbox](/tutorials/customer-support-inbox/)               | Relations + hooks                                                 | ~25m |
| 3  | [E-commerce storefront widget](/tutorials/ecommerce-storefront-widget/)    | Dual auth — same data, two audiences                              | ~35m |
| 4  | [Real estate leads](/tutorials/real-estate-leads/)                         | Plugins + events — the system reacts on its own                   | ~45m |
| 5  | [Multi-tenant bookings](/tutorials/multi-tenant-bookings/)                 | The agent **takes actions** with approval gates                   | ~60m |
| 6  | [Internal IT helpdesk](/tutorials/internal-it-helpdesk/)                   | The agent reaches outside the database (web + KB + tickets)       | ~45m |

## How to read them

Each tutorial is self-contained — you can drop into any one of them on
a fresh project without having done the previous tutorials. They share
conventions (file layout, env-var names, the Slack-app setup
checklist), so if a step feels familiar from an earlier tutorial,
it's the same step.

If you've never used dAvePi before, do **[Quickstart](/quickstart/)**
first — it's a five-minute orientation that explains the schema /
admin / MCP loop without the agent in the picture. Then come back here
and start with the [habit tracker](/tutorials/habit-tracker/).

## Common prerequisites (do once)

You'll need these for every tutorial:

- **Node 18+** and **Docker** (for the local MongoDB).
- An **Anthropic API key** (or OpenAI — the agent supports both):
  `ANTHROPIC_API_KEY=sk-ant-...` or `OPENAI_API_KEY=sk-...`.
- A throwaway **Slack workspace** with a bot you control. The
  per-tutorial sections walk through the bot setup, but it's the same
  five-minute exercise each time — you can reuse the bot across
  tutorials if you parametrise the channel.
- **`ngrok`** or a similar tunnel, to expose Slack-side webhooks at
  your local agent during dev. (Or use Slack socket mode — see
  [Surfaces → Agent](/surfaces/agent/).)
- Tutorial #5 also needs Twilio sandbox + Stripe test-mode credentials.
- Tutorial #6 also needs a Tavily (or equivalent) web-search API key.

## The single line that sells the stack

> *"You wrote one schema file. You wrote zero glue code. The admin
> UI, the REST API, the GraphQL API, the MCP server, the audit log,
> the Slack bot, the SMS reminders, and the customer-facing chat
> widget all came from that file."*

Save it for the close.
