function posixBasename(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] || '';
}

function normalizePosixPath(p: string): string {
  const isAbs = p.startsWith('/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') {
        out.pop();
      } else if (!isAbs) {
        out.push('..');
      }
    } else {
      out.push(seg);
    }
  }
  const joined = out.join('/');
  return isAbs ? `/${joined}` : joined || '.';
}

const BLOCKED_EXACT_PATHS = new Set([
  '/server.ts',
  '/server.js',
  '/firebase-applet-config.json',
  '/firestore.rules',
  '/firebase-blueprint.json',
  '/security_spec.md',
  '/package.json',
  '/package-lock.json',
  '/bun.lock',
  '/tsconfig.json',
  '/vite.config.ts',
  '/eslint.config.mjs',
  '/wrangler.toml',
  '/env.example',
]);

const BLOCKED_PREFIXES = [
  '/data',
  '/scripts',
  '/src/lib',
  '/functions',
  '/.git',
  '/.aistudio',
];

function fullyDecodePath(rawPath: string): { ok: boolean; value: string } {
  let current = rawPath;
  for (let i = 0; i < 4; i++) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) {
        return { ok: true, value: current };
      }
      current = next;
    } catch {
      return { ok: false, value: current };
    }
  }
  return { ok: true, value: current };
}

function checkNormalizedPath(normLower: string): boolean {
  const baseName = posixBasename(normLower);
  if (baseName.startsWith('.env')) {
    return true;
  }
  if (normLower.split('/').some((seg) => seg.startsWith('.env'))) {
    return true;
  }
  if (BLOCKED_EXACT_PATHS.has(normLower)) {
    return true;
  }
  for (const prefix of BLOCKED_PREFIXES) {
    if (normLower === prefix || normLower.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Blocks direct HTTP access to server source files, local database backups,
 * Firebase/security configuration, dotfiles (.env, .git), and admin scripts
 * across Express, Vite dev middleware (including /@fs/), and Cloudflare Pages Functions.
 */
export function isBlockedHttpPath(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const pathOnly = rawUrl.split(/[?#]/)[0] || '/';
  const decoded = fullyDecodePath(pathOnly);
  if (!decoded.ok) {
    return true;
  }

  const slashNormalized = decoded.value.replace(/\\/g, '/').replace(/\/+/g, '/');
  const normalized = normalizePosixPath(
    slashNormalized.startsWith('/') ? slashNormalized : `/${slashNormalized}`
  );
  const lower = normalized.toLowerCase();

  if (checkNormalizedPath(lower)) {
    return true;
  }

  // Guard Vite /@fs/<abs-path> reads targeting sensitive project paths
  if (lower.startsWith('/@fs/')) {
    const fsTarget = lower.slice('/@fs'.length);
    if (
      fsTarget.includes('/data/') ||
      fsTarget.endsWith('/data') ||
      fsTarget.includes('/scripts/') ||
      fsTarget.includes('/src/lib/') ||
      fsTarget.endsWith('/server.ts') ||
      fsTarget.endsWith('/server.js') ||
      fsTarget.endsWith('/firebase-applet-config.json') ||
      fsTarget.endsWith('/firestore.rules') ||
      fsTarget.endsWith('/firebase-blueprint.json') ||
      fsTarget.endsWith('/package.json') ||
      fsTarget.includes('/.git') ||
      fsTarget.split('/').some((seg) => seg.startsWith('.env'))
    ) {
      return true;
    }
  }

  return false;
}

export interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export class InMemoryRateLimiter {
  private buckets = new Map<string, RateLimitBucket>();
  private maxBuckets: number;

  constructor(maxBuckets = 10_000) {
    this.maxBuckets = maxBuckets;
  }

  private pruneExpired(now: number) {
    if (this.buckets.size < this.maxBuckets) return;
    for (const [key, bucket] of this.buckets.entries()) {
      if (now > bucket.resetAt) {
        this.buckets.delete(key);
      }
    }
    if (this.buckets.size >= this.maxBuckets) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey) this.buckets.delete(oldestKey);
    }
  }

  check(key: string, maxCount: number, now = Date.now()): { allowed: boolean; retryAfterSec?: number } {
    const bucket = this.buckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      return { allowed: true };
    }
    if (bucket.count >= maxCount) {
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    }
    return { allowed: true };
  }

  hit(key: string, windowMs: number, now = Date.now()): void {
    this.pruneExpired(now);
    const bucket = this.buckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
    } else {
      bucket.count += 1;
    }
  }

  consume(
    key: string,
    maxCount: number,
    windowMs: number,
    now = Date.now()
  ): { allowed: boolean; retryAfterSec?: number } {
    const status = this.check(key, maxCount, now);
    if (!status.allowed) {
      return status;
    }
    this.hit(key, windowMs, now);
    return { allowed: true };
  }

  clear(key: string): void {
    this.buckets.delete(key);
  }
}

export interface SecurityHeadersOptions {
  isProduction: boolean;
  isHttps: boolean;
  allowClientFirebase?: boolean;
}

export function buildProductionCsp(allowClientFirebase = false): string {
  const connectSources = allowClientFirebase
    ? "'self' https://firestore.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com"
    : "'self'";

  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    `connect-src ${connectSources}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}

export function buildSecurityHeaders(options: SecurityHeadersOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };

  if (options.isProduction) {
    headers['Content-Security-Policy'] = buildProductionCsp(Boolean(options.allowClientFirebase));
    headers['X-Frame-Options'] = 'SAMEORIGIN';
    headers['X-DNS-Prefetch-Control'] = 'off';
    headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    headers['Permissions-Policy'] = 'camera=(), microphone=(), geolocation=(), payment=()';

    if (options.isHttps) {
      headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
    }
  }

  return headers;
}

