import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const configPath = resolve(__dirname, '../../next.config.js');
const ENV_KEYS = ['INTERNAL_API_URL', 'NEXT_PUBLIC_API_URL'] as const;
const CONFIG_LOADER = `
const config = require(process.argv[1]);
Promise.all([config.headers(), config.rewrites()]).then(([headers, rewrites]) => {
  process.stdout.write(JSON.stringify({
    headers,
    rewrites,
    hasRedirects: typeof config.redirects === 'function',
    poweredByHeader: config.poweredByHeader,
    devIndicators: config.devIndicators,
    productionBrowserSourceMaps: config.productionBrowserSourceMaps,
    images: config.images,
  }));
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
`;

interface ConfigSnapshot {
  headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  rewrites: Array<{ source: string; destination: string }>;
  hasRedirects: boolean;
  poweredByHeader: boolean;
  devIndicators: false;
  productionBrowserSourceMaps: boolean;
  images: { dangerouslyAllowSVG: boolean; remotePatterns: unknown[] };
}

interface ConfigEnvironment extends Partial<Record<(typeof ENV_KEYS)[number], string>> {
  NODE_ENV: 'development' | 'production';
}

function loadConfig(env: ConfigEnvironment): ConfigSnapshot {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: env.NODE_ENV };
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  return JSON.parse(execFileSync(process.execPath, ['-e', CONFIG_LOADER, configPath], {
    encoding: 'utf8',
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })) as ConfigSnapshot;
}

function responseHeaders(config: ConfigSnapshot, source = '/(.*)') {
  const entry = config.headers.find((candidate) => candidate.source === source);
  if (!entry) throw new Error(`Missing header rule for ${source}`);
  return new Map(entry.headers.map(({ key, value }) => [key, value]));
}

describe('Next.js production security configuration', () => {
  it('limits production connections to trusted configured origins', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      NEXT_PUBLIC_API_URL: 'https://app.lunchlineup.com/api/v1',
    });
    const headers = responseHeaders(config);
    const policy = headers.get('Content-Security-Policy') ?? '';
    expect(policy).toContain(
      "connect-src 'self' https://challenges.cloudflare.com https://app.lunchlineup.com",
    );
    expect(policy).not.toMatch(/connect-src[^;]*\shttps:\s/);
    expect(policy).not.toMatch(/connect-src[^;]*\swss?:\/\//);
    expect(policy).not.toContain('localhost');
    expect(policy).not.toContain('127.0.0.1');
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).toContain("script-src-attr 'none'");
    expect(headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains; preload');
  });

  it('keeps loopback connections available only for local development', () => {
    const config = loadConfig({
      NODE_ENV: 'development',
      NEXT_PUBLIC_API_URL: '/api/v1',
    });
    const headers = responseHeaders(config);
    const policy = headers.get('Content-Security-Policy') ?? '';
    expect(policy).toContain('http://localhost:*');
    expect(policy).not.toMatch(/connect-src[^;]*\swss?:\/\//);
    expect(headers.has('Strict-Transport-Security')).toBe(false);
  });

  it('rejects insecure or malformed production origins', () => {
    expect(() => loadConfig({
      NODE_ENV: 'production',
      NEXT_PUBLIC_API_URL: 'http://app.lunchlineup.com/api/v1',
    })).toThrow();
  });

  it('disables disclosure, public source maps, remote images, and custom redirects', () => {
    const config = loadConfig({ NODE_ENV: 'production' });
    expect(config.poweredByHeader).toBe(false);
    expect(config.devIndicators).toBe(false);
    expect(config.productionBrowserSourceMaps).toBe(false);
    expect(config.images).toEqual({ dangerouslyAllowSVG: false, remotePatterns: [] });
    expect(config.hasRedirects).toBe(false);
    expect(config.rewrites).toEqual([
      { source: '/api/v1/:path*', destination: 'http://api:3000/v1/:path*' },
    ]);
  });

  it('prevents reset-token routes from sending a Referer or being cached', () => {
    const config = loadConfig({ NODE_ENV: 'production' });
    const headers = responseHeaders(config, '/auth/reset-password');

    expect(headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(headers.get('Cache-Control')).toBe('no-store');
  });
});
