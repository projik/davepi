// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Astro Starlight configuration for the dAvePi docs site. The site
// builds to static HTML under `dist/` and is intended to ship to
// docs.davepi.dev via Cloudflare Pages / Netlify / Vercel — pick
// your CDN; the GitHub Action under `.github/workflows/docs.yml`
// produces the static bundle on every push to main.

export default defineConfig({
  site: 'https://docs.davepi.dev',
  integrations: [
    starlight({
      title: 'dAvePi',
      description:
        'The schema-driven backend AI agents build on. REST + GraphQL + MCP from one schema file.',
      // GitHub link in the top bar; "Edit this page" footer wired to
      // the source markdown so contributors can fix typos directly.
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/projik/davepi',
        },
      ],
      editLink: {
        baseUrl:
          'https://github.com/projik/davepi/edit/main/docs/site/src/content/docs/',
      },
      // Sidebar mirrors the IA from issue #53: orientation first,
      // then concepts, then the schema reference, then per-feature
      // guides, then operations.
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'What is dAvePi?', link: '/' },
            { label: 'Quickstart', link: '/quickstart/' },
            { label: 'Idea to deployed CRM in 10 minutes', link: '/guides/crm-in-10-minutes/' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'Schema-driven generation', link: '/concepts/schema-driven/' },
            { label: 'Tenant isolation', link: '/concepts/tenancy/' },
            { label: 'Hot reload', link: '/concepts/hot-reload/' },
            { label: 'Why agents come first', link: '/concepts/agent-first/' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Schema file shape', link: '/reference/schema/' },
            { label: 'Field options', link: '/reference/fields/' },
            { label: 'Conventions', link: '/reference/conventions/' },
            { label: 'Errors', link: '/reference/errors/' },
            { label: 'Stability commitments', link: '/reference/stability/' },
          ],
        },
        {
          label: 'Features',
          items: [{ autogenerate: { directory: 'features' } }],
        },
        {
          label: 'Surfaces',
          items: [
            { label: 'REST', link: '/surfaces/rest/' },
            { label: 'GraphQL', link: '/surfaces/graphql/' },
            { label: 'MCP server', link: '/surfaces/mcp/' },
            { label: '_describe manifest', link: '/surfaces/describe/' },
            { label: 'TypeScript client', link: '/surfaces/client/' },
          ],
        },
        {
          label: 'Operations',
          items: [
            { label: 'Deployment', link: '/operations/deployment/' },
            { label: 'Migrations', link: '/operations/migrations/' },
            { label: 'Backup & retention', link: '/operations/backup/' },
          ],
        },
      ],
      // Pagefind is bundled by default — no extra config needed for
      // search.
    }),
  ],
});
