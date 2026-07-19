import { getCollection } from 'astro:content';

const SITE = 'https://dokkimi.com';

const staticPages = [
  { path: '/', changefreq: 'weekly', priority: 1.0 },
  { path: '/docs/', changefreq: 'monthly', priority: 0.7 },
  { path: '/docs/project-structure/', changefreq: 'monthly', priority: 0.7 },
  { path: '/docs/services/', changefreq: 'monthly', priority: 0.7 },
  { path: '/docs/databases/', changefreq: 'monthly', priority: 0.7 },
  { path: '/docs/brokers/', changefreq: 'monthly', priority: 0.7 },
  { path: '/docs/mocks/', changefreq: 'monthly', priority: 0.7 },
  { path: '/docs/tests-and-steps/', changefreq: 'monthly', priority: 0.7 },
  { path: '/docs/actions/', changefreq: 'monthly', priority: 0.7 },
  { path: '/docs/assertions/', changefreq: 'monthly', priority: 0.7 },
  { path: '/docs/variables/', changefreq: 'monthly', priority: 0.7 },
  { path: '/docs/refs/', changefreq: 'monthly', priority: 0.7 },
  { path: '/docs/loops/', changefreq: 'monthly', priority: 0.7 },
  { path: '/docs/cli/', changefreq: 'monthly', priority: 0.7 },
  { path: '/docs/ci/', changefreq: 'monthly', priority: 0.7 },
  { path: '/docs/ai-integration/', changefreq: 'monthly', priority: 0.7 },
  { path: '/docs/release-notes/', changefreq: 'weekly', priority: 0.5 },
  { path: '/blogs/', changefreq: 'weekly', priority: 0.8 },
  { path: '/tutorials/', changefreq: 'weekly', priority: 0.8 },
  { path: '/cookie-policy/', changefreq: 'yearly', priority: 0.3 },
  { path: '/sitemap/', changefreq: 'monthly', priority: 0.3 },
];

export async function GET() {
  const blogPosts = await getCollection('blog');
  const tutorials = await getCollection('tutorials');

  const dynamicPages = [
    ...blogPosts.map((post) => ({
      path: `/blogs/${post.data.slug}/`,
      changefreq: 'monthly',
      priority: 0.8,
    })),
    ...tutorials.map((tutorial) => ({
      path: `/tutorials/${tutorial.data.slug}/`,
      changefreq: 'monthly',
      priority: 0.8,
    })),
  ];

  const allPages = [...staticPages, ...dynamicPages];
  const today = new Date().toISOString().split('T')[0];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${allPages
  .map(
    (page) => `  <url>
    <loc>${SITE}${page.path}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>
  </url>`,
  )
  .join('\n')}
</urlset>`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml' },
  });
}
