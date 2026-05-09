import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The admin SPA is served from the API at `/admin` in production.
// Setting `base` so all generated <script> / <link> URLs are
// `/admin/assets/...` — without it the prebuilt index.html would
// 404 on its own bundle when loaded under a sub-path.
export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      // In dev, proxy API + Swagger to the Express server so the
      // SPA can hit /api/v1/* and /api-docs/swagger.json without
      // CORS gymnastics.
      '/api': 'http://localhost:4001',
      '/api-docs': 'http://localhost:4001',
      '/login': 'http://localhost:4001',
      '/register': 'http://localhost:4001',
      '/auth': 'http://localhost:4001',
    },
  },
});
