import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The site's own imports (`@/lib/...`), so that tests can load its route handlers as Next.js does.
  resolve: { alias: { '@': fileURLToPath(new URL('./apps/web', import.meta.url)) } },
});
