/**
 * Single source of truth for analytics / consent identifiers.
 *
 * Used by the shared <ConsentMode /> and <GtmNoscript /> components and by the
 * build-time integrity guard (scripts/check-analytics-integrity.mjs).
 *
 * GA4 measurement is configured INSIDE the GTM container, not in code. Consent
 * Mode v2 defaults are denied here and updated to granted by the cookie banner.
 */
export const GTM_ID = 'GTM-K9K2L7R4';

/** Static assets the consent manager (vanilla-cookieconsent) loads at runtime. */
export const CONSENT_ASSETS = [
  '/assets/consent-manager/cookieconsent.css',
  '/assets/consent-manager/cookieconsent.umd.js',
] as const;
