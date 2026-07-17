import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readAppFile = (name: string) => readFileSync(resolve(__dirname, '../../app', name), 'utf8');

describe('public metadata contract', () => {
  it('publishes canonical Open Graph and Twitter metadata', () => {
    const layout = readAppFile('layout.tsx');
    expect(layout).toContain("metadataBase: new URL(appOrigin)");
    expect(layout).toContain("canonical: '/'");
    expect(layout).toContain("url: '/opengraph-image'");
    expect(layout).toContain("card: 'summary_large_image'");
  });

  it('keeps authenticated surfaces out of crawler routes', () => {
    const robots = readAppFile('robots.ts');
    for (const route of ['/admin/', '/api/', '/auth/', '/dashboard/', '/mfa/', '/onboarding/']) {
      expect(robots).toContain(`'${route}'`);
    }
    const sitemap = readAppFile('sitemap.ts');
    for (const route of ['/privacy', '/security', '/status', '/subprocessors', '/terms']) {
      expect(sitemap).toContain(`'${route}'`);
    }
    expect(sitemap).not.toContain('/dashboard');
    expect(sitemap).not.toContain('/admin');
  });

  it('provides a generated 1200 by 630 Open Graph image', () => {
    const image = readAppFile('opengraph-image.tsx');
    expect(image).toContain("import { ImageResponse } from 'next/og'");
    expect(image).toContain('width: 1200');
    expect(image).toContain('height: 630');
    expect(image).toContain("contentType = 'image/png'");
  });
});