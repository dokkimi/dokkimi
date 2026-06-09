// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://dokkimi.com',
  output: 'static',
  trailingSlash: 'always',
  integrations: [
    sitemap({
      changefreq: 'weekly',
      priority: 0.7,
      lastmod: new Date(),
      customPages: [],
      serialize(item) {
        if (item.url === 'https://dokkimi.com/') {
          return { ...item, priority: 1.0, changefreq: 'weekly' };
        }
        if (item.url.includes('/blog/') || item.url.includes('/tutorials/')) {
          return { ...item, priority: 0.8, changefreq: 'monthly' };
        }
        if (item.url.includes('/docs/')) {
          return { ...item, priority: 0.7, changefreq: 'monthly' };
        }
        return { ...item, priority: 0.5, changefreq: 'weekly' };
      },
    }),
  ],
});
