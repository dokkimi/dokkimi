// @ts-check
import { defineConfig } from 'astro/config';
import sanity from '@sanity/astro';

export default defineConfig({
  site: 'https://dokkimi.com',
  output: 'static',
  integrations: [
    sanity({
      projectId: '0yrq9bug',
      dataset: 'production',
      useCdn: false,
    }),
  ],
});
