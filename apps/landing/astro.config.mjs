// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://dokkimi.com',
  output: 'static',
  integrations: [sitemap()],
});
