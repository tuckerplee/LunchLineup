import { expect, test, type APIResponse } from '@playwright/test';

async function expectPublicMetadataResponse(response: APIResponse, contentType: RegExp) {
  expect(response.status()).toBe(200);
  expect(response.headers().location).toBeUndefined();
  expect(response.headers()['content-type']).toMatch(contentType);
  expect(response.headers()['cache-control']).toBeTruthy();
  expect(response.headers()['x-content-type-options']).toBe('nosniff');
}

test.describe('Public crawler and social metadata', () => {
  test('serves robots.txt without an authentication redirect', async ({ request }) => {
    const response = await request.get('/robots.txt', { maxRedirects: 0 });
    await expectPublicMetadataResponse(response, /^text\/plain\b/i);

    const body = await response.text();
    expect(body).toContain('User-Agent: *');
    expect(body).toContain('Disallow: /dashboard/');
    expect(body).toContain('Sitemap: https://lunchlineup.com/sitemap.xml');
    expect(body).not.toContain('/auth/login');
  });

  test('serves the public-only sitemap without an authentication redirect', async ({ request }) => {
    const response = await request.get('/sitemap.xml', { maxRedirects: 0 });
    await expectPublicMetadataResponse(response, /^(?:application|text)\/xml\b/i);

    const body = await response.text();
    expect(body).toContain('<urlset');
    expect(body).toContain('<loc>https://lunchlineup.com/status</loc>');
    expect(body).not.toContain('/dashboard');
    expect(body).not.toContain('/auth/login');
  });

  test('serves the generated PNG social image without an authentication redirect', async ({ request }) => {
    const response = await request.get('/opengraph-image', { maxRedirects: 0 });
    await expectPublicMetadataResponse(response, /^image\/png\b/i);

    const body = await response.body();
    expect([...body.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(body.byteLength).toBeGreaterThan(1_000);
  });
});
