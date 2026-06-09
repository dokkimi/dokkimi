#!/usr/bin/env node
/**
 * Build-time guard for consent / analytics integrity.
 *
 * Catches the exact class of regression that has bitten this site before:
 *   - the GTM snippet silently disappearing from a layout
 *   - a layout shipping without the consent banner (orphaned consent plumbing)
 *   - the self-hosted cookie-consent assets being referenced but missing from
 *     /public (banner throws at runtime, analytics_storage stuck on 'denied')
 *
 * Runs automatically before `astro build` (see package.json "prebuild").
 * Zero dependencies — pure Node, reads files as text.
 *
 * Exit code 0 = all good, 1 = problem found (fails the build / CI).
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

// --- 1. Read the single source of truth -------------------------------------
const analyticsPath = join(root, 'src/lib/analytics.ts');
if (!existsSync(analyticsPath)) {
  errors.push(
    'Missing src/lib/analytics.ts (single source of truth for GTM_ID / assets).',
  );
}
const analyticsSrc = existsSync(analyticsPath)
  ? readFileSync(analyticsPath, 'utf8')
  : '';

const gtmId =
  (analyticsSrc.match(/GTM_ID\s*=\s*['"]([^'"]+)['"]/) || [])[1] || '';
if (!/^GTM-[A-Z0-9]+$/.test(gtmId)) {
  errors.push(
    `GTM_ID is missing or malformed in analytics.ts (got: "${gtmId}").`,
  );
}

const assetPaths = [
  ...analyticsSrc.matchAll(/['"](\/assets\/consent-manager\/[^'"]+)['"]/g),
].map((m) => m[1]);
if (assetPaths.length === 0) {
  errors.push(
    'No consent-manager assets declared in analytics.ts CONSENT_ASSETS.',
  );
}

// --- 2. Consent assets must actually exist in /public -----------------------
for (const p of assetPaths) {
  if (!existsSync(join(root, 'public', p.replace(/^\//, '')))) {
    errors.push(`Consent asset referenced but missing from /public: ${p}`);
  }
}

// --- 3. Every layout must include the shared consent + GTM components --------
const layoutsDir = join(root, 'src/layouts');
const layouts = existsSync(layoutsDir)
  ? readdirSync(layoutsDir).filter((f) => f.endsWith('.astro'))
  : [];
if (layouts.length === 0) {
  errors.push('No layouts found in src/layouts.');
}

for (const file of layouts) {
  const src = readFileSync(join(layoutsDir, file), 'utf8');
  if (!/<ConsentMode\b/.test(src)) {
    errors.push(
      `${file}: missing <ConsentMode /> in <head> (consent banner + Consent Mode defaults).`,
    );
  }
  if (!/<GtmNoscript\b/.test(src)) {
    errors.push(
      `${file}: missing <GtmNoscript /> as first child of <body> (GTM noscript fallback).`,
    );
  }
}

// --- 4. The GTM id must not be hard-coded outside the shared component -------
// (prevents a stray container id drifting away from analytics.ts)
for (const file of layouts) {
  const src = readFileSync(join(layoutsDir, file), 'utf8');
  const stray = src.match(/GTM-[A-Z0-9]+/);
  if (stray && stray[0] !== gtmId) {
    errors.push(
      `${file}: hard-coded ${stray[0]} differs from analytics.ts GTM_ID (${gtmId}). Use <ConsentMode /> instead.`,
    );
  }
}

// --- Report -----------------------------------------------------------------
if (errors.length) {
  console.error('\n✗ Analytics integrity check failed:\n');
  for (const e of errors) {
    console.error('  • ' + e);
  }
  console.error(
    '\nFix the above before building. See src/components/ConsentMode.astro.\n',
  );
  process.exit(1);
}

console.log(
  `✓ Analytics integrity OK (${gtmId}, ${assetPaths.length} assets, ${layouts.length} layouts).`,
);
