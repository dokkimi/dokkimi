import { resolveBrowserImage, DEFAULT_CHROME_VERSION } from './image-tags';

describe('image-tags', () => {
  describe('resolveBrowserImage', () => {
    it('returns default chrome version when no config', () => {
      expect(resolveBrowserImage()).toBe(
        `chromedp/headless-shell:${DEFAULT_CHROME_VERSION}`,
      );
    });

    it('returns default chrome version when config has no version', () => {
      expect(resolveBrowserImage({})).toBe(
        `chromedp/headless-shell:${DEFAULT_CHROME_VERSION}`,
      );
    });

    it('returns custom version when provided', () => {
      expect(resolveBrowserImage({ version: '120.0.0.0' })).toBe(
        'chromedp/headless-shell:120.0.0.0',
      );
    });

    it('returns default when version is empty string', () => {
      expect(resolveBrowserImage({ version: '' })).toBe(
        `chromedp/headless-shell:${DEFAULT_CHROME_VERSION}`,
      );
    });
  });
});
