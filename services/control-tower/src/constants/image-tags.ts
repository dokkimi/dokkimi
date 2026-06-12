// Evaluated once at module load — APP_VERSION must be set before import
const VERSION = process.env.APP_VERSION || 'latest';

export const DEFAULT_CHROME_VERSION = '148.0.7778.56';

export const DOKKIMI_IMAGES = {
  interceptor: `ghcr.io/dokkimi/interceptor:${VERSION}`,
  testAgent: `ghcr.io/dokkimi/test-agent:${VERSION}`,
  dbProxyPostgres: `ghcr.io/dokkimi/db-proxy-postgres:${VERSION}`,
  dbProxyMysql: `ghcr.io/dokkimi/db-proxy-mysql:${VERSION}`,
  dbProxyMongo: `ghcr.io/dokkimi/db-proxy-mongo:${VERSION}`,
  dbProxyRedis: `ghcr.io/dokkimi/db-proxy-redis:${VERSION}`,
  dnsmasq: 'andyshinn/dnsmasq:2.83',
  // Standalone chromium pod for UI e2e tests. chromedp/headless-shell is the
  // build the chromedp Go library targets, ~120 MB compressed. Deployed as its
  // own pod with dnsmasq so browser traffic routes through interceptors.
  // Pinned (not :latest) so visual regression baselines stay stable across
  // runs — anti-aliasing and font rendering shift between Chromium versions.
  chromiumHeadless: `chromedp/headless-shell:${DEFAULT_CHROME_VERSION}`,
  initFetcher: 'busybox:1.37',
};

/**
 * Resolves the browser image from the definition's config.browser block.
 * Falls back to the default pinned chrome version when no config is provided.
 */
export function resolveBrowserImage(browser?: { version?: string }): string {
  const version = browser?.version || DEFAULT_CHROME_VERSION;
  return `chromedp/headless-shell:${version}`;
}
