import { Hono, type Context } from 'hono';
import type { CustomerProfile, Product } from '../types/index.ts';
import type { StoredUserRecord } from '../lib/migrateDbToFirestore.ts';
import { FirestoreRestClient, parseServiceAccountEdge } from '../lib/firestoreRest.ts';
import { EdgeStoreRepository } from '../lib/edgeStoreRepository.ts';
import {
  createOtpRecordEdge,
  hashPasswordPbkdf2,
  randomHex,
  sha256Hex,
} from '../utils/edgeCrypto.ts';
import {
  isValidEmail,
  validateStrongPassword,
} from '../utils/edgeValidation.ts';
import {
  InMemoryRateLimiter,
  buildSecurityHeaders,
  isBlockedHttpPath,
} from '../utils/httpSecurity.ts';
import {
  getEffectivePrice,
  getNormalizedGallery,
  sanitizeProductPricing,
  validateOrderInput,
} from '../utils/pricing.ts';
import { validateImagePayloadBudget } from '../utils/productCatalog.ts';

export interface EdgeEnv {
  NODE_ENV?: string;
  FIREBASE_SERVICE_ACCOUNT_KEY?: string;
  FIREBASE_DATABASE_ID?: string;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_RECOVERY_EMAIL?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  VITE_FIREBASE_PROJECT_ID?: string;
  VITE_FIREBASE_API_KEY?: string;
  FIRESTORE_ORIGIN?: string;
  OAUTH_TOKEN_URL?: string;
  GOOGLE_JWK_URL?: string;
}

export interface CreateEdgeApiOptions {
  repositoryFactory?: (env: EdgeEnv) => EdgeStoreRepository | null;
  fetcher?: typeof fetch;
}

const SESSION_COOKIE_NAME = 'rgd_session';

const loginAttempts = new InMemoryRateLimiter();
const otpRequests = new InMemoryRateLimiter();
const publicAndOrderLimiter = new InMemoryRateLimiter();
const bootstrappedEnvs = new Set<string>();

function sanitizeUser(u: StoredUserRecord): CustomerProfile {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    phone: u.phone || '',
    address: u.address || '',
    city: u.city || '',
    postalCode: u.postalCode || '',
    country: u.country || '',
  };
}

function isRequestHttps(req: Request): boolean {
  const forwarded = req.headers.get('x-forwarded-proto');
  if (forwarded) {
    return forwarded.split(',')[0].trim().toLowerCase() === 'https';
  }
  try {
    return new URL(req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

function getClientIp(req: Request): string {
  const cfIp = req.headers.get('cf-connecting-ip');
  if (cfIp && cfIp.trim()) return cfIp.trim();
  const xf = req.headers.get('x-forwarded-for');
  if (xf && xf.trim()) return xf.split(',')[0].trim();
  return 'unknown';
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.get('cookie');
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.get('authorization');
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+([A-Za-z0-9._\-]+)$/i);
  return match && match[1] ? match[1].trim() : null;
}

function buildSessionCookieHeader(req: Request, rawToken: string, maxAgeMs: number): string {
  const isHttps = isRequestHttps(req);
  const maxAgeSec = Math.max(0, Math.floor(maxAgeMs / 1000));
  const attrs = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}`,
    'Path=/',
    `Max-Age=${maxAgeSec}`,
    'HttpOnly',
    isHttps ? 'SameSite=None' : 'SameSite=Lax',
  ];
  if (isHttps) attrs.push('Secure');
  return attrs.join('; ');
}

function buildClearSessionCookieHeader(req: Request): string {
  const isHttps = isRequestHttps(req);
  const attrs = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    isHttps ? 'SameSite=None' : 'SameSite=Lax',
  ];
  if (isHttps) attrs.push('Secure');
  return attrs.join('; ');
}

function isProductionRequest(c: Context<{ Bindings: EdgeEnv }>): boolean {
  if (c.env?.NODE_ENV === 'production') return true;
  try {
    const url = new URL(c.req.url);
    return url.hostname !== 'localhost' && url.hostname !== '127.0.0.1';
  } catch {
    return true;
  }
}

async function readJsonBody(c: Context): Promise<Record<string, any>> {
  try {
    const parsed = await c.req.json();
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function getEmailProviderStatus(env: EdgeEnv): {
  configured: boolean;
  provider: 'resend' | 'none';
} {
  if (env.RESEND_API_KEY && env.RESEND_API_KEY.trim().length > 0) {
    return { configured: true, provider: 'resend' };
  }
  return { configured: false, provider: 'none' };
}

async function sendRecoveryOtpEmailEdge(
  env: EdgeEnv,
  toEmail: string,
  otpCode: string,
  fetcher: typeof fetch
): Promise<{ sent: boolean; error?: string }> {
  const status = getEmailProviderStatus(env);
  if (!status.configured) {
    return {
      sent: false,
      error:
        'Email delivery service is not configured on this server. Configure RESEND_API_KEY in Cloudflare Pages environment secrets to enable OTP recovery.',
    };
  }

  const fromAddress = (env.EMAIL_FROM || 'RGD LUXE Security <onboarding@resend.dev>').trim();
  const subject = 'RGD LUXE Admin Security Verification Code';
  const html = `
    <div style="font-family: Georgia, serif; background:#09090B; color:#F5F5F7; padding:32px; border:1px solid #C6A45B;">
      <p style="letter-spacing:0.25em; font-size:11px; color:#C6A45B; text-transform:uppercase; margin:0 0 12px;">RGD LUXE · Admin Security</p>
      <h2 style="margin:0 0 16px; color:#FFFFFF; font-weight:normal;">Password Recovery Verification Code</h2>
      <p style="color:#A1A1AA; font-size:14px; line-height:1.6;">
        Use the single-use verification code below to reset your Maison Director password. This code expires in <strong>5 minutes</strong>.
      </p>
      <div style="margin:24px 0; padding:18px 24px; background:#111115; border:1px solid #C6A45B; display:inline-block; font-family:monospace; font-size:28px; letter-spacing:0.35em; color:#E8CA7A;">
        ${otpCode}
      </div>
      <p style="color:#71717A; font-size:12px; margin-top:20px;">
        If you did not request this recovery code, do not share it and check your admin account security immediately.
      </p>
    </div>
  `;
  const text = `RGD LUXE Admin Password Recovery OTP: ${otpCode}. This code expires in 5 minutes and can only be used once.`;

  try {
    const response = await fetcher('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY!.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [toEmail],
        subject,
        html,
        text,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      return { sent: false, error: `Email provider rejected delivery (${response.status}): ${errBody}` };
    }
    return { sent: true };
  } catch (err: any) {
    return { sent: false, error: err?.message || 'Failed to dispatch OTP email.' };
  }
}

async function buildValidatedProductPayloadEdge(
  store: EdgeStoreRepository,
  body: Record<string, any>,
  existing?: Product
): Promise<{ product?: Product; error?: string }> {
  const name = typeof body.name === 'string' ? body.name.trim() : existing?.name || '';
  if (name.length < 2) {
    return { error: 'Product name is required.' };
  }

  const category = (body.category || existing?.category || 'watches') as 'men' | 'women' | 'watches';
  if (!['men', 'women', 'watches'].includes(category)) {
    return { error: 'Invalid product category.' };
  }

  const categoryLabel =
    category === 'watches'
      ? 'Luxury Watches'
      : category === 'men'
      ? "Men's Clothing"
      : "Women's Clothing";

  const rawImages: string[] = Array.isArray(body.images)
    ? body.images.map((s: any) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean)
    : body.image && typeof body.image === 'string'
    ? [body.image.trim()]
    : existing
    ? getNormalizedGallery(existing)
    : [];

  const uniqueImages = Array.from(new Set(rawImages));
  if (uniqueImages.length === 0) {
    return { error: 'At least one product image is required.' };
  }

  const requestedMain = typeof body.image === 'string' ? body.image.trim() : '';
  const mainImage =
    requestedMain && uniqueImages.includes(requestedMain) ? requestedMain : uniqueImages[0];
  const orderedImages = [mainImage, ...uniqueImages.filter((u) => u !== mainImage)];
  const budget = validateImagePayloadBudget(orderedImages);
  if (!budget.valid) {
    return { error: budget.error || 'Product image gallery exceeds allowed limits.' };
  }

  const pricing = sanitizeProductPricing({
    originalPrice:
      body.originalPrice !== undefined
        ? Number(body.originalPrice)
        : existing?.originalPrice ?? existing?.price,
    price: body.price !== undefined ? Number(body.price) : existing?.price,
    discountEnabled:
      body.discountEnabled !== undefined ? Boolean(body.discountEnabled) : existing?.discountEnabled,
    discountPercentage:
      body.discountPercentage !== undefined
        ? Number(body.discountPercentage)
        : existing?.discountPercentage,
  });

  if (!pricing.valid) {
    return { error: pricing.error || 'Invalid product pricing configuration.' };
  }

  const stockCount = Math.max(0, Math.round(Number(body.stockCount ?? existing?.stockCount ?? 0)));
  const requestedId =
    !existing && typeof body.id === 'string' && /^[a-zA-Z0-9_-]{3,80}$/.test(body.id.trim())
      ? body.id.trim()
      : null;

  let resolvedId: string = existing?.id ?? '';
  if (!resolvedId) {
    if (requestedId && !(await store.hasProductId(requestedId))) {
      resolvedId = requestedId;
    } else {
      resolvedId = `rgd-cust-${Date.now()}`;
    }
  }

  const product: Product = {
    id: resolvedId,
    name,
    subtitle: typeof body.subtitle === 'string' ? body.subtitle.trim() : existing?.subtitle || '',
    category,
    categoryLabel,
    price: pricing.price,
    originalPrice: pricing.originalPrice,
    discountEnabled: pricing.discountEnabled,
    discountPercentage: pricing.discountPercentage,
    rating: Number(body.rating ?? existing?.rating ?? 5.0),
    reviewsCount: Number(body.reviewsCount ?? existing?.reviewsCount ?? 0),
    image: mainImage,
    images: orderedImages,
    description:
      typeof body.description === 'string' ? body.description.trim() : existing?.description || '',
    details: Array.isArray(body.details)
      ? body.details
      : existing?.details || ['Bespoke Luxury Release'],
    composition:
      typeof body.composition === 'string'
        ? body.composition
        : existing?.composition || '100% Bespoke Materials',
    sizes:
      Array.isArray(body.sizes) && body.sizes.length > 0 ? body.sizes : existing?.sizes || ['One Size'],
    colors:
      Array.isArray(body.colors) && body.colors.length > 0
        ? body.colors
        : existing?.colors || [{ name: 'Obsidian & Gold', hex: '#C6A45B' }],
    inStock: stockCount > 0,
    stockCount,
    isNewArrival:
      body.isNewArrival !== undefined ? Boolean(body.isNewArrival) : existing?.isNewArrival ?? true,
    isBestSeller:
      body.isBestSeller !== undefined ? Boolean(body.isBestSeller) : existing?.isBestSeller ?? false,
    isSpecialOffer:
      body.isSpecialOffer !== undefined
        ? Boolean(body.isSpecialOffer)
        : existing?.isSpecialOffer ?? pricing.discountEnabled,
    sku:
      typeof body.sku === 'string' && body.sku.trim()
        ? body.sku.trim()
        : existing?.sku || `RGD-CUSTOM-${Math.floor(1000 + Math.random() * 9000)}`,
    isDemo: body.isDemo !== undefined ? Boolean(body.isDemo) : existing?.isDemo ?? false,
  };

  return { product };
}

export function createEdgeApiApp(options: CreateEdgeApiOptions = {}) {
  const app = new Hono<{ Bindings: EdgeEnv }>();
  const fetcher = options.fetcher || ((input, init) => fetch(input, init));

  function resolveClient(env: EdgeEnv): { client?: FirestoreRestClient; error?: string } {
    const parsed = parseServiceAccountEdge(env.FIREBASE_SERVICE_ACCOUNT_KEY || '');
    if (!parsed) {
      return {
        error:
          'Backend persistence is not configured: set FIREBASE_SERVICE_ACCOUNT_KEY and FIREBASE_DATABASE_ID in Cloudflare Pages Environment Variables.',
      };
    }
    const databaseId = (env.FIREBASE_DATABASE_ID || '(default)').trim() || '(default)';
    const client = new FirestoreRestClient({
      serviceAccount: parsed,
      databaseId,
      firestoreOrigin: env.FIRESTORE_ORIGIN,
      oauthTokenUrl: env.OAUTH_TOKEN_URL,
      jwkUrl: env.GOOGLE_JWK_URL,
      fetcher,
    });
    return { client };
  }

  async function resolveRepo(
    env: EdgeEnv
  ): Promise<{ repo?: EdgeStoreRepository; client?: FirestoreRestClient; error?: string }> {
    if (options.repositoryFactory) {
      const repo = options.repositoryFactory(env);
      if (!repo) {
        return { error: 'Backend persistence is not configured.' };
      }
      const bootstrapKey = `${repo.projectId}:${repo.databaseId}:${env.ADMIN_EMAIL || ''}`;
      if (!bootstrappedEnvs.has(bootstrapKey)) {
        await repo.ensureAdminBootstrappedIfAbsent({
          email: env.ADMIN_EMAIL,
          password: env.ADMIN_PASSWORD,
          recoveryEmail: env.ADMIN_RECOVERY_EMAIL,
        });
        bootstrappedEnvs.add(bootstrapKey);
      }
      return { repo };
    }

    const { client, error } = resolveClient(env);
    if (!client) return { error };
    const repo = new EdgeStoreRepository(client);

    const bootstrapKey = `${repo.projectId}:${repo.databaseId}:${env.ADMIN_EMAIL || ''}`;
    if (!bootstrappedEnvs.has(bootstrapKey)) {
      await repo.ensureAdminBootstrappedIfAbsent({
        email: env.ADMIN_EMAIL,
        password: env.ADMIN_PASSWORD,
        recoveryEmail: env.ADMIN_RECOVERY_EMAIL,
      });
      bootstrappedEnvs.add(bootstrapKey);
    }

    return { repo, client };
  }

  async function getAuthContext(c: Context<{ Bindings: EdgeEnv }>, repo: EdgeStoreRepository) {
    const cookies = parseCookies(c.req.raw);
    const rawToken = cookies[SESSION_COOKIE_NAME] || extractBearerToken(c.req.raw);
    if (!rawToken) return null;
    const tokenHash = await sha256Hex(rawToken);
    return await repo.getAuthContextByTokenHash(tokenHash);
  }

  // Global security headers + path blocking + no-cache + CSRF guard on /api/*
  app.use('*', async (c, next) => {
    const securityHeaders = buildSecurityHeaders({
      isProduction: isProductionRequest(c),
      isHttps: isRequestHttps(c.req.raw),
      allowClientFirebase: Boolean(
        c.env?.VITE_FIREBASE_PROJECT_ID && c.env?.VITE_FIREBASE_API_KEY
      ),
    });

    if (isBlockedHttpPath(c.req.path)) {
      const blockedRes = c.json({ error: 'Access denied.' }, 403);
      for (const [k, v] of Object.entries(securityHeaders)) {
        blockedRes.headers.set(k, v);
      }
      return blockedRes;
    }

    if (c.req.path.startsWith('/api')) {
      const method = c.req.method.toUpperCase();
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        const cookieHeader = c.req.header('cookie') || '';
        const authHeader = c.req.header('authorization') || '';
        const hasSessionCookie = cookieHeader.includes(`${SESSION_COOKIE_NAME}=`);
        const hasBearerToken = authHeader.toLowerCase().startsWith('bearer ');
        if (hasSessionCookie || hasBearerToken) {
          const originHeader = c.req.header('origin');
          const refererHeader = c.req.header('referer');
          const sourceUrl =
            originHeader && originHeader !== 'null' ? originHeader : refererHeader || '';
          if (sourceUrl) {
            try {
              const parsedOrigin = new URL(sourceUrl);
              const expectedHost = String(
                c.req.header('x-forwarded-host') || c.req.header('host') || ''
              )
                .split(',')[0]
                .trim()
                .toLowerCase();
              if (expectedHost && parsedOrigin.host.toLowerCase() !== expectedHost) {
                return c.json({ error: 'Cross-site request origin rejected.' }, 403);
              }
            } catch {
              return c.json({ error: 'Malformed request origin header.' }, 403);
            }
          }
        }
      }
    }

    await next();

    for (const [k, v] of Object.entries(securityHeaders)) {
      c.res.headers.set(k, v);
    }
    if (c.req.path.startsWith('/api')) {
      c.res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      c.res.headers.set('Pragma', 'no-cache');
      c.res.headers.set('Expires', '0');
    }
  });

  // --- HEALTH ---
  app.get('/api/health', async (c) => {
    const resolved = await resolveRepo(c.env || {}).catch((err) => ({
      error: (err as Error)?.message || 'Firestore connection failed.',
      repo: undefined,
      client: undefined,
    }));
    if (!resolved.repo) {
      return c.json(
        {
          status: 'degraded',
          brand: 'RGD LUXE',
          runtime: 'cloudflare-pages-functions',
          persistenceMode: 'unconfigured',
          error: resolved.error,
          timestamp: new Date().toISOString(),
        },
        503
      );
    }

    return c.json({
      status: 'healthy',
      brand: 'RGD LUXE',
      runtime: 'cloudflare-pages-functions',
      persistenceMode: 'firestore',
      projectId: resolved.repo.projectId,
      databaseId: resolved.repo.databaseId,
      timestamp: new Date().toISOString(),
    });
  });

  // --- AUTH ---
  app.get('/api/auth/me', async (c) => {
    try {
      const { repo } = await resolveRepo(c.env || {});
      if (!repo) return c.json({ user: null });
      const auth = await getAuthContext(c, repo);
      if (!auth) return c.json({ user: null });
      return c.json({ user: sanitizeUser(auth.user) });
    } catch {
      return c.json({ user: null });
    }
  });

  async function handleLogin(c: Context<{ Bindings: EdgeEnv }>, adminOnly: boolean) {
    try {
      const { repo, error } = await resolveRepo(c.env || {});
      if (!repo) {
        return c.json({ error: error || 'Authentication backend is not configured.' }, 503);
      }

      const body = await readJsonBody(c);
      const cleanEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const rawPassword = typeof body.password === 'string' ? body.password : '';

      if (!cleanEmail || !rawPassword) {
        return c.json({ error: 'Email and password are required.' }, 400);
      }

      const ip = getClientIp(c.req.raw);
      const ipEmailKey = `${ip}:${cleanEmail}`;
      const emailKey = `email:${cleanEmail}`;
      const ipLimit = loginAttempts.check(ipEmailKey, 5);
      const emailLimit = loginAttempts.check(emailKey, 10);
      if (!ipLimit.allowed || !emailLimit.allowed) {
        const retry = Math.max(ipLimit.retryAfterSec || 0, emailLimit.retryAfterSec || 0);
        return c.json(
          {
            error: `Too many failed sign-in attempts. Please wait ${retry} seconds before trying again.`,
          },
          429
        );
      }

      const user = await repo.findUserByEmail(cleanEmail);
      const passwordOk = user ? await repo.verifyAndUpgradeUserPassword(user, rawPassword) : false;
      if (!user || !passwordOk) {
        loginAttempts.hit(ipEmailKey, 15 * 60 * 1000);
        loginAttempts.hit(emailKey, 15 * 60 * 1000);
        return c.json({ error: 'Invalid credentials. Access denied.' }, 401);
      }

      if (adminOnly && user.role !== 'admin') {
        loginAttempts.hit(ipEmailKey, 15 * 60 * 1000);
        loginAttempts.hit(emailKey, 15 * 60 * 1000);
        return c.json({ error: 'Access denied: Administrator privileges required.' }, 403);
      }

      loginAttempts.clear(ipEmailKey);
      loginAttempts.clear(emailKey);
      const { rawToken, ttlMs } = await repo.createSession(user);
      c.header('Set-Cookie', buildSessionCookieHeader(c.req.raw, rawToken, ttlMs));
      return c.json({ user: sanitizeUser(user), sessionToken: rawToken });
    } catch (err) {
      console.error('[Edge Login Error]', (err as Error)?.message || err);
      return c.json({ error: 'Authentication service failed.' }, 500);
    }
  }

  app.post('/api/auth/login', (c) => handleLogin(c, false));
  app.post('/api/auth/admin/login', (c) => handleLogin(c, true));

  app.post('/api/auth/register', async (c) => {
    try {
      const { repo, error } = await resolveRepo(c.env || {});
      if (!repo) {
        return c.json({ error: error || 'Registration service is not configured.' }, 503);
      }

      const regKey = `reg:${getClientIp(c.req.raw)}`;
      const regLimit = otpRequests.consume(regKey, 5, 15 * 60 * 1000);
      if (!regLimit.allowed) {
        return c.json(
          {
            error: `Too many registration attempts. Please wait ${regLimit.retryAfterSec} seconds.`,
          },
          429
        );
      }

      const body = await readJsonBody(c);
      const cleanEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const { name, password, phone, address, city, postalCode } = body;

      if (!name || typeof name !== 'string' || name.trim().length < 2) {
        return c.json({ error: 'Full name is required.' }, 400);
      }
      if (!isValidEmail(cleanEmail)) {
        return c.json({ error: 'Valid email address is required.' }, 400);
      }
      const passCheck = validateStrongPassword(password);
      if (!passCheck.valid) {
        return c.json({ error: passCheck.error }, 400);
      }

      const existing = await repo.findUserByEmail(cleanEmail);
      if (existing) {
        return c.json({ error: 'An account with this email already exists.' }, 409);
      }

      const passwordHash = await hashPasswordPbkdf2(password);
      const newUser: StoredUserRecord = {
        id: `usr_${randomHex(6)}`,
        email: cleanEmail,
        name: name.trim(),
        passwordHash,
        role: 'customer',
        phone: typeof phone === 'string' ? phone.trim() : '',
        address: typeof address === 'string' ? address.trim() : '',
        city: typeof city === 'string' ? city.trim() : '',
        postalCode: typeof postalCode === 'string' ? postalCode.trim() : '',
        country: 'United States',
      };

      await repo.createUser(newUser);
      const { rawToken, ttlMs } = await repo.createSession(newUser);
      c.header('Set-Cookie', buildSessionCookieHeader(c.req.raw, rawToken, ttlMs));

      return c.json({ user: sanitizeUser(newUser), sessionToken: rawToken }, 201);
    } catch (err) {
      console.error('[Edge Register Error]', (err as Error)?.message || err);
      return c.json({ error: 'Account registration failed.' }, 500);
    }
  });

  app.post('/api/auth/logout', async (c) => {
    try {
      const { repo } = await resolveRepo(c.env || {});
      if (repo) {
        const cookies = parseCookies(c.req.raw);
        const rawToken = cookies[SESSION_COOKIE_NAME] || extractBearerToken(c.req.raw);
        if (rawToken) {
          const tokenHash = await sha256Hex(rawToken);
          await repo.deleteSessionByTokenHash(tokenHash);
        }
      }
    } catch {
      // still clear cookie
    }
    c.header('Set-Cookie', buildClearSessionCookieHeader(c.req.raw));
    return c.json({ success: true });
  });

  // --- FORGOT PASSWORD OTP ---
  app.post('/api/auth/forgot-password/request-otp', async (c) => {
    try {
      const env = c.env || {};
      const emailProvider = getEmailProviderStatus(env);
      if (!emailProvider.configured) {
        return c.json(
          {
            error:
              'Password recovery email service is not configured yet. Set RESEND_API_KEY in Cloudflare Pages environment secrets before requesting an OTP.',
          },
          503
        );
      }

      const { repo, error } = await resolveRepo(env);
      if (!repo) {
        return c.json({ error: error || 'Persistence service is not configured.' }, 503);
      }

      const body = await readJsonBody(c);
      const cleanEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (!isValidEmail(cleanEmail)) {
        return c.json({ error: 'Please enter a valid email address.' }, 400);
      }

      const ipKey = `otp:${getClientIp(c.req.raw)}`;
      const emailOtpKey = `otp-email:${cleanEmail}`;
      const ipLimit = otpRequests.check(ipKey, 3);
      const emailLimit = otpRequests.check(emailOtpKey, 3);
      if (!ipLimit.allowed || !emailLimit.allowed) {
        const retry = Math.max(ipLimit.retryAfterSec || 0, emailLimit.retryAfterSec || 0);
        return c.json(
          {
            error: `Too many OTP requests. Please wait ${retry} seconds before requesting another code.`,
          },
          429
        );
      }
      otpRequests.hit(ipKey, 15 * 60 * 1000);
      otpRequests.hit(emailOtpKey, 15 * 60 * 1000);

      const admin = await repo.findAdminByEmail(cleanEmail);
      const neutralSuccess =
        'If this email is registered as an administrator account, a 6-digit verification code has been dispatched to the private recovery inbox. The code expires in 5 minutes.';

      if (!admin) {
        return c.json({ success: true, message: neutralSuccess });
      }

      const destinationEmail = (
        admin.recoveryEmail ||
        env.ADMIN_RECOVERY_EMAIL ||
        admin.email
      ).trim();

      const { otp, record } = await createOtpRecordEdge(admin.id, admin.email);
      await repo.replaceActiveOtpsForUser(admin.id, record);

      const delivery = await sendRecoveryOtpEmailEdge(env, destinationEmail, otp, fetcher);
      if (!delivery.sent) {
        await repo.markOtpUsed(record.id);
        return c.json(
          { error: delivery.error || 'Email service failed to deliver the verification code.' },
          502
        );
      }

      return c.json({ success: true, message: neutralSuccess });
    } catch (err) {
      console.error('[Edge Request OTP Error]', (err as Error)?.message || err);
      return c.json({ error: 'Unable to process recovery OTP request.' }, 500);
    }
  });

  app.post('/api/auth/forgot-password/verify-otp', async (c) => {
    try {
      const { repo, error } = await resolveRepo(c.env || {});
      if (!repo) {
        return c.json({ error: error || 'Persistence service is not configured.' }, 503);
      }

      const body = await readJsonBody(c);
      const cleanEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const cleanOtp = typeof body.otp === 'string' ? body.otp.trim() : '';

      const verifyKey = `otp-verify:${getClientIp(c.req.raw)}:${cleanEmail}`;
      const verifyLimit = otpRequests.check(verifyKey, 8);
      if (!verifyLimit.allowed) {
        return c.json(
          {
            error: `Too many verification attempts. Please wait ${verifyLimit.retryAfterSec} seconds.`,
          },
          429
        );
      }

      if (!isValidEmail(cleanEmail) || !/^\d{6}$/.test(cleanOtp)) {
        otpRequests.hit(verifyKey, 15 * 60 * 1000);
        return c.json(
          { error: 'Valid email address and 6-digit verification code are required.' },
          400
        );
      }

      const result = await repo.verifyOtp(cleanEmail, cleanOtp);
      if (!result.success || !result.resetGrantToken) {
        otpRequests.hit(verifyKey, 15 * 60 * 1000);
        return c.json({ error: result.error || 'Invalid or expired verification code.' }, 400);
      }

      otpRequests.clear(verifyKey);
      return c.json({
        success: true,
        resetGrantToken: result.resetGrantToken,
        message: 'Code verified. You may now set a new strong password.',
      });
    } catch (err) {
      console.error('[Edge Verify OTP Error]', (err as Error)?.message || err);
      return c.json({ error: 'OTP verification failed.' }, 500);
    }
  });

  app.post('/api/auth/forgot-password/reset-password', async (c) => {
    try {
      const { repo, error } = await resolveRepo(c.env || {});
      if (!repo) {
        return c.json({ error: error || 'Persistence service is not configured.' }, 503);
      }

      const body = await readJsonBody(c);
      const cleanEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const { resetGrantToken, newPassword, confirmPassword } = body;

      const resetKey = `otp-reset:${getClientIp(c.req.raw)}:${cleanEmail}`;
      const resetLimit = otpRequests.check(resetKey, 5);
      if (!resetLimit.allowed) {
        return c.json(
          {
            error: `Too many password reset attempts. Please wait ${resetLimit.retryAfterSec} seconds.`,
          },
          429
        );
      }

      if (!isValidEmail(cleanEmail)) {
        otpRequests.hit(resetKey, 15 * 60 * 1000);
        return c.json({ error: 'Valid email address is required.' }, 400);
      }
      if (!newPassword || newPassword !== confirmPassword) {
        return c.json({ error: 'New password and confirmation do not match.' }, 400);
      }
      const strength = validateStrongPassword(newPassword);
      if (!strength.valid) {
        return c.json({ error: strength.error }, 400);
      }

      const newHash = await hashPasswordPbkdf2(newPassword);
      const result = await repo.consumeResetGrantAndUpdateAdminPassword({
        email: cleanEmail,
        resetGrantToken: typeof resetGrantToken === 'string' ? resetGrantToken : '',
        newPasswordHash: newHash,
      });

      if (!result.valid) {
        otpRequests.hit(resetKey, 15 * 60 * 1000);
        return c.json(
          { error: result.error || 'Verified OTP session is invalid or expired.' },
          400
        );
      }

      otpRequests.clear(resetKey);
      c.header('Set-Cookie', buildClearSessionCookieHeader(c.req.raw));
      return c.json({
        success: true,
        message: 'Administrator password has been reset. Please sign in with your new password.',
      });
    } catch (err) {
      console.error('[Edge Reset Password Error]', (err as Error)?.message || err);
      return c.json({ error: 'Password reset failed.' }, 500);
    }
  });

  // --- ADMIN AUTHORIZATION HELPER ---
  async function requireAdminSession(c: Context<{ Bindings: EdgeEnv }>) {
    const resolved = await resolveRepo(c.env || {});
    if (!resolved.repo) {
      return {
        errorRes: c.json({ error: resolved.error || 'Persistence service unavailable.' }, 503),
      };
    }
    const auth = await getAuthContext(c, resolved.repo);
    if (!auth) {
      return {
        errorRes: c.json({ error: 'Administrator authentication required.' }, 401),
      };
    }
    if (auth.user.role !== 'admin') {
      return {
        errorRes: c.json({ error: 'Access denied: Administrator privileges required.' }, 403),
      };
    }
    return { repo: resolved.repo, client: resolved.client, auth };
  }

  async function requireUserSession(c: Context<{ Bindings: EdgeEnv }>) {
    const resolved = await resolveRepo(c.env || {});
    if (!resolved.repo) {
      return {
        errorRes: c.json({ error: resolved.error || 'Persistence service unavailable.' }, 503),
      };
    }
    const auth = await getAuthContext(c, resolved.repo);
    if (!auth) {
      return {
        errorRes: c.json({ error: 'Authentication required. Please sign in.' }, 401),
      };
    }
    return { repo: resolved.repo, client: resolved.client, auth };
  }

  // --- ADMIN SETTINGS ---
  app.get('/api/admin/settings', async (c) => {
    const gate = await requireAdminSession(c);
    if (gate.errorRes) return gate.errorRes;

    const env = c.env || {};
    const emailProvider = getEmailProviderStatus(env);
    const hasRecovery = Boolean(gate.auth.user.recoveryEmail || env.ADMIN_RECOVERY_EMAIL);

    return c.json({
      adminEmail: gate.auth.user.email,
      name: gate.auth.user.name,
      hasPrivateRecoveryEmail: hasRecovery,
      emailServiceConfigured: emailProvider.configured,
      emailProvider: emailProvider.provider,
      persistenceMode: 'firestore',
      projectId: gate.repo.projectId,
      databaseId: gate.repo.databaseId,
    });
  });

  app.put('/api/admin/settings/email', async (c) => {
    try {
      const gate = await requireAdminSession(c);
      if (gate.errorRes) return gate.errorRes;

      const body = await readJsonBody(c);
      const { currentPassword, newEmail } = body;
      const passwordOk = currentPassword
        ? await gate.repo.verifyAndUpgradeUserPassword(gate.auth.user, String(currentPassword))
        : false;
      if (!passwordOk) {
        return c.json({ error: 'Current administrator password is incorrect.' }, 401);
      }

      const cleanNewEmail = typeof newEmail === 'string' ? newEmail.trim().toLowerCase() : '';
      if (!isValidEmail(cleanNewEmail)) {
        return c.json({ error: 'Please enter a valid new administrator email address.' }, 400);
      }
      if (cleanNewEmail === gate.auth.user.email.toLowerCase()) {
        return c.json({ error: 'New email matches your current administrator email.' }, 400);
      }
      const conflict = await gate.repo.findUserByEmail(cleanNewEmail);
      if (conflict && conflict.id !== gate.auth.user.id) {
        return c.json({ error: 'This email address is already associated with another account.' }, 409);
      }

      const { updatedUser, rawToken, ttlMs } = await gate.repo.updateAdminProfileAndRotateSession({
        user: gate.auth.user,
        patch: { email: cleanNewEmail },
        envRecoveryEmail: c.env?.ADMIN_RECOVERY_EMAIL,
      });
      c.header('Set-Cookie', buildSessionCookieHeader(c.req.raw, rawToken, ttlMs));

      return c.json({
        success: true,
        user: sanitizeUser(updatedUser),
        sessionToken: rawToken,
        message: 'Administrator email updated successfully.',
      });
    } catch (err) {
      console.error('[Edge Update Admin Email Error]', (err as Error)?.message || err);
      return c.json({ error: 'Failed to update administrator email.' }, 500);
    }
  });

  app.put('/api/admin/settings/password', async (c) => {
    try {
      const gate = await requireAdminSession(c);
      if (gate.errorRes) return gate.errorRes;

      const body = await readJsonBody(c);
      const { currentPassword, newPassword, confirmPassword } = body;
      const passwordOk = currentPassword
        ? await gate.repo.verifyAndUpgradeUserPassword(gate.auth.user, String(currentPassword))
        : false;
      if (!passwordOk) {
        return c.json({ error: 'Current administrator password is incorrect.' }, 401);
      }
      if (!newPassword || newPassword !== confirmPassword) {
        return c.json({ error: 'New password and confirmation do not match.' }, 400);
      }
      if (newPassword === currentPassword) {
        return c.json({ error: 'New password must differ from your current password.' }, 400);
      }
      const strength = validateStrongPassword(newPassword);
      if (!strength.valid) {
        return c.json({ error: strength.error }, 400);
      }

      const newHash = await hashPasswordPbkdf2(newPassword);
      const { rawToken, ttlMs } = await gate.repo.updateAdminProfileAndRotateSession({
        user: gate.auth.user,
        patch: { passwordHash: newHash },
        envRecoveryEmail: c.env?.ADMIN_RECOVERY_EMAIL,
      });
      c.header('Set-Cookie', buildSessionCookieHeader(c.req.raw, rawToken, ttlMs));

      return c.json({
        success: true,
        sessionToken: rawToken,
        message: 'Administrator password updated and active sessions rotated.',
      });
    } catch (err) {
      console.error('[Edge Update Admin Password Error]', (err as Error)?.message || err);
      return c.json({ error: 'Failed to update administrator password.' }, 500);
    }
  });

  app.put('/api/admin/settings/recovery-email', async (c) => {
    try {
      const gate = await requireAdminSession(c);
      if (gate.errorRes) return gate.errorRes;

      const body = await readJsonBody(c);
      const { currentPassword, newRecoveryEmail } = body;
      const passwordOk = currentPassword
        ? await gate.repo.verifyAndUpgradeUserPassword(gate.auth.user, String(currentPassword))
        : false;
      if (!passwordOk) {
        return c.json({ error: 'Current administrator password is incorrect.' }, 401);
      }

      const cleanRecovery =
        typeof newRecoveryEmail === 'string' ? newRecoveryEmail.trim().toLowerCase() : '';
      if (!isValidEmail(cleanRecovery)) {
        return c.json({ error: 'Please enter a valid private recovery email address.' }, 400);
      }

      await gate.repo.updateAdminRecoveryEmail(gate.auth.user.id, cleanRecovery);
      return c.json({
        success: true,
        hasPrivateRecoveryEmail: true,
        message: 'Private recovery email updated securely (kept hidden from public UI).',
      });
    } catch (err) {
      console.error('[Edge Update Recovery Email Error]', (err as Error)?.message || err);
      return c.json({ error: 'Failed to update recovery email.' }, 500);
    }
  });

  app.post('/api/admin/cloud-sync-claim', async (c) => {
    try {
      const gate = await requireAdminSession(c);
      if (gate.errorRes) return gate.errorRes;

      if (!gate.client) {
        return c.json({ error: 'Server-side Firestore REST verification is unavailable.' }, 503);
      }

      const body = await readJsonBody(c);
      const idToken = typeof body.idToken === 'string' ? body.idToken.trim() : '';
      if (!idToken) {
        return c.json({ error: 'Firebase ID token is required.' }, 400);
      }

      const decoded = await gate.client.verifyFirebaseIdToken(idToken);
      if (!decoded.email_verified || !decoded.email) {
        return c.json({ error: 'Verified Google account email is required.' }, 403);
      }

      const result = await gate.repo.grantAdminCloudAccess(decoded.uid, decoded.email);
      return c.json({
        success: true,
        uid: decoded.uid,
        customClaimSet: result.customClaimSet,
      });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Unable to verify Firebase ID token.' }, 401);
    }
  });

  app.post('/api/admin/upload-image', async (c) => {
    const gate = await requireAdminSession(c);
    if (gate.errorRes) return gate.errorRes;
    return c.json(
      {
        error:
          'Disk file uploads are not supported on Cloudflare Pages Functions. Upload images via the product modal compressor or paste a valid URL.',
      },
      501
    );
  });

  // --- PRODUCTS ---
  app.get('/api/products', async (c) => {
    try {
      const { repo, error } = await resolveRepo(c.env || {});
      if (!repo) {
        return c.json({ error: error || 'Unable to connect to product database.' }, 503);
      }

      let results = await repo.listProducts();
      const category = c.req.query('category');
      const search = c.req.query('search');
      const sort = c.req.query('sort');
      const filter = c.req.query('filter');

      if (category && category !== 'all') {
        results = results.filter((p) => p.category === category);
      }

      if (search) {
        const q = search.toLowerCase().trim();
        results = results.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.subtitle.toLowerCase().includes(q) ||
            p.description.toLowerCase().includes(q) ||
            p.categoryLabel.toLowerCase().includes(q)
        );
      }

      if (filter === 'new') {
        results = results.filter((p) => p.isNewArrival);
      } else if (filter === 'bestseller') {
        results = results.filter((p) => p.isBestSeller);
      } else if (filter === 'offer') {
        results = results.filter((p) => p.isSpecialOffer || p.discountEnabled);
      }

      if (sort === 'price_asc') {
        results.sort((a, b) => getEffectivePrice(a) - getEffectivePrice(b));
      } else if (sort === 'price_desc') {
        results.sort((a, b) => getEffectivePrice(b) - getEffectivePrice(a));
      } else if (sort === 'rating') {
        results.sort((a, b) => b.rating - a.rating);
      }

      return c.json({
        products: results,
        total: results.length,
        persistenceMode: 'firestore',
      });
    } catch (err) {
      console.error('[Edge List Products Error]', (err as Error)?.message || err);
      return c.json({ error: 'Unable to load product catalog.' }, 500);
    }
  });

  app.get('/api/products/:id', async (c) => {
    try {
      const { repo, error } = await resolveRepo(c.env || {});
      if (!repo) {
        return c.json({ error: error || 'Unable to connect to product database.' }, 503);
      }
      const prod = await repo.getProductById(c.req.param('id'));
      if (!prod) {
        return c.json({ error: 'Product not found' }, 404);
      }
      return c.json(prod);
    } catch (err) {
      console.error('[Edge Get Product Error]', (err as Error)?.message || err);
      return c.json({ error: 'Unable to load product details.' }, 500);
    }
  });

  app.post('/api/products', async (c) => {
    try {
      const gate = await requireAdminSession(c);
      if (gate.errorRes) return gate.errorRes;

      const body = await readJsonBody(c);
      const result = await buildValidatedProductPayloadEdge(gate.repo, body);
      if (!result.product) {
        return c.json({ error: result.error }, 400);
      }

      const created = await gate.repo.createProduct({
        ...result.product,
        sortOrder:
          typeof body.sortOrder === 'number' && Number.isFinite(body.sortOrder)
            ? body.sortOrder
            : Date.now(),
      });
      return c.json(created, 201);
    } catch (err) {
      console.error('[Edge Create Product Error]', (err as Error)?.message || err);
      return c.json({ error: 'Unable to save new product.' }, 500);
    }
  });

  app.put('/api/products/:id', async (c) => {
    try {
      const gate = await requireAdminSession(c);
      if (gate.errorRes) return gate.errorRes;

      const id = c.req.param('id');
      const existing = await gate.repo.getProductById(id);
      if (!existing) {
        return c.json({ error: 'Product not found' }, 404);
      }

      const body = await readJsonBody(c);
      const result = await buildValidatedProductPayloadEdge(gate.repo, body, existing);
      if (!result.product) {
        return c.json({ error: result.error }, 400);
      }

      const updated = await gate.repo.updateProduct(id, {
        ...result.product,
        sortOrder:
          typeof body.sortOrder === 'number' && Number.isFinite(body.sortOrder)
            ? body.sortOrder
            : undefined,
      });
      if (!updated) {
        return c.json({ error: 'Product not found' }, 404);
      }
      return c.json(updated);
    } catch (err) {
      console.error('[Edge Update Product Error]', (err as Error)?.message || err);
      return c.json({ error: 'Unable to update product.' }, 500);
    }
  });

  app.delete('/api/products/:id', async (c) => {
    try {
      const gate = await requireAdminSession(c);
      if (gate.errorRes) return gate.errorRes;

      const removed = await gate.repo.deleteProduct(c.req.param('id'));
      if (!removed) {
        return c.json({ error: 'Product not found' }, 404);
      }
      return c.json({ success: true, message: 'Product removed from collection.' });
    } catch (err) {
      console.error('[Edge Delete Product Error]', (err as Error)?.message || err);
      return c.json({ error: 'Unable to remove product.' }, 500);
    }
  });

  // --- ORDERS ---
  app.get('/api/orders', async (c) => {
    try {
      const gate = await requireUserSession(c);
      if (gate.errorRes) return gate.errorRes;

      if (gate.auth.user.role === 'admin') {
        const orders = await gate.repo.listAllOrders();
        return c.json({ orders });
      }
      const ownOrders = await gate.repo.listOrdersForCustomer(gate.auth.user.id);
      return c.json({ orders: ownOrders });
    } catch (err) {
      console.error('[Edge Get Orders Error]', (err as Error)?.message || err);
      return c.json({ error: 'Failed to retrieve orders.' }, 500);
    }
  });

  app.get('/api/admin/orders', async (c) => {
    try {
      const gate = await requireAdminSession(c);
      if (gate.errorRes) return gate.errorRes;
      const orders = await gate.repo.listAllOrders();
      return c.json({ orders });
    } catch (err) {
      console.error('[Edge Admin Orders Error]', (err as Error)?.message || err);
      return c.json({ error: 'Failed to load orders.' }, 500);
    }
  });

  app.post('/api/orders', async (c) => {
    try {
      const { repo, error } = await resolveRepo(c.env || {});
      if (!repo) {
        return c.json({ error: error || 'Order backend is not configured.' }, 503);
      }

      const ip = getClientIp(c.req.raw);
      const auth = await getAuthContext(c, repo);
      const windowMs = 15 * 60 * 1000;

      const ipCap = publicAndOrderLimiter.check(`orders:ip:${ip}`, 20);
      if (!ipCap.allowed) {
        c.header('Retry-After', String(ipCap.retryAfterSec || 60));
        return c.json(
          {
            error: `Too many order requests from this network. Please wait ${ipCap.retryAfterSec} seconds.`,
          },
          429
        );
      }

      if (auth?.user.id) {
        const userCap = publicAndOrderLimiter.check(`orders:user:${auth.user.id}`, 10);
        if (!userCap.allowed) {
          c.header('Retry-After', String(userCap.retryAfterSec || 60));
          return c.json(
            {
              error: `Order submission limit reached for this account. Please wait ${userCap.retryAfterSec} seconds before placing another order.`,
            },
            429
          );
        }
      } else {
        const guestIpCap = publicAndOrderLimiter.check(`orders:guest-ip:${ip}`, 8);
        if (!guestIpCap.allowed) {
          c.header('Retry-After', String(guestIpCap.retryAfterSec || 60));
          return c.json(
            {
              error: `Too many guest checkout attempts from this IP. Please sign in or wait ${guestIpCap.retryAfterSec} seconds.`,
            },
            429
          );
        }
      }

      publicAndOrderLimiter.hit(`orders:ip:${ip}`, windowMs);
      if (auth?.user.id) {
        publicAndOrderLimiter.hit(`orders:user:${auth.user.id}`, windowMs);
      } else {
        publicAndOrderLimiter.hit(`orders:guest-ip:${ip}`, windowMs);
      }

      const body = await readJsonBody(c);
      const { customer, items, paymentMethod, notes, promoCode } = body;

      const customerValidation = validateOrderInput(customer || {});
      if (!customerValidation.valid) {
        const firstError =
          Object.values(customerValidation.errors)[0] || 'Incomplete customer delivery information.';
        return c.json({ error: firstError, errors: customerValidation.errors }, 400);
      }

      if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
        return c.json(
          {
            error:
              items && items.length > 50 ? 'Too many line items in a single order.' : 'Cart is empty.',
          },
          400
        );
      }

      const method = paymentMethod === 'cod' ? 'cod' : 'card_demo';

      const txResult = await repo.createOrderTransaction({
        items,
        customer: {
          name: customer.name.trim(),
          email: customer.email.trim().toLowerCase(),
          phone: customer.phone.trim(),
          address: customer.address.trim(),
          city: customer.city.trim(),
          postalCode: customer.postalCode.trim(),
          country: (customer.country || 'United States').trim(),
        },
        userId: auth?.user.id,
        paymentMethod: method,
        promoCode: typeof promoCode === 'string' ? promoCode : undefined,
        notes: typeof notes === 'string' ? notes.trim().slice(0, 1000) : '',
      });

      if (!txResult.order) {
        return c.json(
          { error: txResult.error || 'Unable to place order.' },
          (txResult.statusCode || 400) as any
        );
      }

      return c.json(txResult.order, 201);
    } catch (err) {
      console.error('[Edge Create Order Error]', (err as Error)?.message || err);
      return c.json({ error: 'Order transaction failed.' }, 500);
    }
  });

  app.put('/api/orders/:id/status', async (c) => {
    try {
      const gate = await requireAdminSession(c);
      if (gate.errorRes) return gate.errorRes;

      const body = await readJsonBody(c);
      const { status, trackingNumber } = body;
      const allowedStatuses = ['Confirmed', 'Processing', 'Dispatched', 'Delivered', 'Cancelled'];
      if (status && !allowedStatuses.includes(status)) {
        return c.json({ error: 'Invalid order status.' }, 400);
      }

      const updated = await gate.repo.updateOrderStatus(c.req.param('id'), {
        status,
        trackingNumber:
          typeof trackingNumber === 'string' && trackingNumber.trim()
            ? trackingNumber.trim()
            : undefined,
      });
      if (!updated) {
        return c.json({ error: 'Order not found' }, 404);
      }
      return c.json(updated);
    } catch (err) {
      console.error('[Edge Update Order Status Error]', (err as Error)?.message || err);
      return c.json({ error: 'Failed to update order status.' }, 500);
    }
  });

  // --- NEWSLETTER & CONTACT ---
  app.post('/api/newsletter', async (c) => {
    try {
      const { repo, error } = await resolveRepo(c.env || {});
      if (!repo) {
        return c.json({ error: error || 'Subscription service is not configured.' }, 503);
      }

      const ip = getClientIp(c.req.raw);
      const limit = publicAndOrderLimiter.consume(`newsletter:ip:${ip}`, 5, 15 * 60 * 1000);
      if (!limit.allowed) {
        c.header('Retry-After', String(limit.retryAfterSec || 60));
        return c.json(
          {
            error: `Too many newsletter subscription attempts. Please wait ${limit.retryAfterSec} seconds.`,
          },
          429
        );
      }

      const body = await readJsonBody(c);
      const { email } = body;
      if (!email || !isValidEmail(String(email))) {
        return c.json({ error: 'Valid email address required.' }, 400);
      }

      await repo.addSubscriber(String(email));
      return c.json({ success: true, message: 'Welcome to the RGD LUXE Private Gazette.' });
    } catch (err) {
      console.error('[Edge Newsletter Error]', (err as Error)?.message || err);
      return c.json({ error: 'Subscription could not be saved.' }, 500);
    }
  });

  app.post('/api/contact', async (c) => {
    try {
      const { repo, error } = await resolveRepo(c.env || {});
      if (!repo) {
        return c.json({ error: error || 'Concierge service is not configured.' }, 503);
      }

      const ip = getClientIp(c.req.raw);
      const limit = publicAndOrderLimiter.consume(`contact:ip:${ip}`, 5, 15 * 60 * 1000);
      if (!limit.allowed) {
        c.header('Retry-After', String(limit.retryAfterSec || 60));
        return c.json(
          {
            error: `Too many concierge inquiries submitted. Please wait ${limit.retryAfterSec} seconds before trying again.`,
          },
          429
        );
      }

      const body = await readJsonBody(c);
      const { name, email, subject, message } = body;
      if (!name || !isValidEmail(String(email || '')) || !message) {
        return c.json({ error: 'Valid name, email, and message are required.' }, 400);
      }

      await repo.addContactMessage({
        id: `msg_${Date.now()}_${randomHex(2)}`,
        name: String(name).trim().slice(0, 120),
        email: String(email).trim().toLowerCase().slice(0, 180),
        subject: String(subject || 'General Concierge Inquiry').trim().slice(0, 200),
        message: String(message).trim().slice(0, 4000),
        createdAt: new Date().toISOString(),
      });
      return c.json({
        success: true,
        message: 'Your concierge inquiry has been securely delivered.',
      });
    } catch (err) {
      console.error('[Edge Contact Error]', (err as Error)?.message || err);
      return c.json({ error: 'Failed to record concierge inquiry.' }, 500);
    }
  });

  app.all('/api/*', (c) => c.json({ error: 'API endpoint not found.' }, 404));

  return app;
}
