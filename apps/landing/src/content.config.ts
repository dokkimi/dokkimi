import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog/posted' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.string(),
    slug: z.string(),
  }),
});

const tutorials = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/tutorials/posted' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.string(),
    slug: z.string(),
  }),
});

export const collections = { blog, tutorials };
