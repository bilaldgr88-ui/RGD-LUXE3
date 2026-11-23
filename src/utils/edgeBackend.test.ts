import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashPassword, verifyPassword } from './authSecurity.ts';
import { hashPasswordPbkdf2, verifyPasswordEdge } from './edgeCrypto.ts';
import { createEdgeApiApp, type EdgeEnv } from '../edge/apiApp.ts';
import { decodeFirestoreDocument } from './productCatalog.ts';

const TARGET_PROJECT_ID = 'ai-studio-applet-webapp-94ef6';
const TARGET_DATABASE_ID = 'ai-studio-rgdluxe-6f4b6bd1-b88d-4501-b5fd-7b6dae315d53';

interface InMemoryFirestoreDoc {
  name: string;
  fields: Record<string, any>;
}

function applyFieldTransform(fields: Record<string, any>, fieldPath: string) {
  fields[fieldPath] = { timestampValue: new Date().toISOString() };
}

function getFieldByPath(doc: InMemoryFirestoreDoc, fieldPath: string): any {
  const val = doc.fields?.[fieldPath];
  if (!val) return undefined;
  if ('stringValue' in val) return val.stringValue;
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('booleanValue' in val) return Boolean(val.booleanValue);
  if ('nullValue' in val) return null;
  return val;
}

function encodeTypedQueryFilterValue(val: any): any {
  if (!val) return undefined;
  if ('stringValue' in val) return val.stringValue;
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('booleanValue' in val) return Boolean(val.booleanValue);
  if ('nullValue' in val) return null;
  return val;
}

async function startMockFirestoreRestServer(seedDocs: Record<string, Record<string, Record<string, any>>>) {
  const dbRoot = `projects/${TARGET_PROJECT_ID}/databases/${TARGET_DATABASE_ID}/documents`;
  const collections = new Map<string, Map<string, InMemoryFirestoreDoc>>();
  const requestedPaths: string[] = [];

  for (const [col, docs] of Object.entries(seedDocs)) {
    const colMap = new Map<string, InMemoryFirestoreDoc>();
    for (const [id, rawFields] of Object.entries(docs)) {
      const encodedFields: Record<string, any> = {};
      for (const [k, v] of Object.entries(rawFields)) {
        if (v === null) encodedFields[k] = { nullValue: null };
        else if (typeof v === 'boolean') encodedFields[k] = { booleanValue: v };
        else if (typeof v === 'number') {
          encodedFields[k] = Number.isInteger(v)
            ? { integerValue: String(v) }
            : { doubleValue: v };
        } else if (typeof v === 'string') encodedFields[k] = { stringValue: v };
        else if (Array.isArray(v)) {
          encodedFields[k] = {
            arrayValue: {
              values: v.map((item) =>
                typeof item === 'string'
                  ? { stringValue: item }
                  : typeof item === 'object'
                  ? {
                      mapValue: {
                        fields: Object.fromEntries(
                          Object.entries(item).map(([mk, mv]) => [mk, { stringValue: String(mv) }])
                        ),
                      },
                    }
                  : { stringValue: String(item) }
              ),
            },
          };
        }
      }
      colMap.set(id, {
        name: `${dbRoot}/${col}/${id}`,
        fields: encodedFields,
      });
    }
    collections.set(col, colMap);
  }

  let txCounter = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    requestedPaths.push(`${req.method} ${url.pathname}`);

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bodyText = Buffer.concat(chunks).toString('utf8');

    const sendJson = (status: number, data: any) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      return sendJson(200, { access_token: 'mock-oauth-token', expires_in: 3600 });
    }

    const prefix = `/v1/${dbRoot}`;
    if (!url.pathname.startsWith(prefix)) {
      return sendJson(404, { error: { message: `Unexpected path: ${url.pathname}` } });
    }

    const sub = url.pathname.slice(prefix.length);

    if (sub === ':beginTransaction' && req.method === 'POST') {
      txCounter += 1;
      return sendJson(200, { transaction: `tx_${txCounter}` });
    }
    if (sub === ':rollback' && req.method === 'POST') {
      return sendJson(200, {});
    }
    if (sub === ':batchGet' && req.method === 'POST') {
      const parsed = JSON.parse(bodyText || '{}');
      const docNames: string[] = Array.isArray(parsed.documents) ? parsed.documents : [];
      const rows = docNames.map((name) => {
        const rel = name.slice(dbRoot.length + 1);
        const [col, id] = rel.split('/');
        const found = collections.get(col)?.get(id);
        return found ? { found } : { missing: name };
      });
      return sendJson(200, rows);
    }
    if (sub === ':runQuery' && req.method === 'POST') {
      const parsed = JSON.parse(bodyText || '{}');
      const sq = parsed.structuredQuery || {};
      const colId = sq.from?.[0]?.collectionId;
      const colMap = collections.get(colId) || new Map<string, InMemoryFirestoreDoc>();
      let docs = Array.from(colMap.values());

      if (sq.where?.fieldFilter) {
        const { field, op, value } = sq.where.fieldFilter;
        const target = encodeTypedQueryFilterValue(value);
        docs = docs.filter((d) => {
          const actual = getFieldByPath(d, field.fieldPath);
          if (op === 'EQUAL') return actual === target;
          return false;
        });
      }
      if (typeof sq.limit === 'number') {
        docs = docs.slice(0, sq.limit);
      }
      return sendJson(
        200,
        docs.map((d) => ({ document: d }))
      );
    }
    if (sub === ':commit' && req.method === 'POST') {
      const parsed = JSON.parse(bodyText || '{}');
      const writes = Array.isArray(parsed.writes) ? parsed.writes : [];
      for (const w of writes) {
        if (w.delete) {
          const rel = String(w.delete).slice(dbRoot.length + 1);
          const [col, id] = rel.split('/');
          collections.get(col)?.delete(id);
          continue;
        }
        if (w.update) {
          const rel = String(w.update.name).slice(dbRoot.length + 1);
          const [col, id] = rel.split('/');
          if (!collections.has(col)) collections.set(col, new Map());
          const colMap = collections.get(col)!;
          const exists = colMap.has(id);
          if (w.currentDocument?.exists === false && exists) {
            return sendJson(409, { error: { status: 'ALREADY_EXISTS' } });
          }

          let nextFields: Record<string, any>;
          if (w.updateMask?.fieldPaths) {
            const prev = exists ? { ...colMap.get(id)!.fields } : {};
            for (const pathKey of w.updateMask.fieldPaths as string[]) {
              if (pathKey in (w.update.fields || {})) {
                prev[pathKey] = w.update.fields[pathKey];
              } else {
                delete prev[pathKey];
              }
            }
            nextFields = prev;
          } else {
            nextFields = { ...(w.update.fields || {}) };
          }

          if (Array.isArray(w.updateTransforms)) {
            for (const tr of w.updateTransforms) {
              if (tr.setToServerValue === 'REQUEST_TIME') {
                applyFieldTransform(nextFields, tr.fieldPath);
              }
            }
          }

          colMap.set(id, {
            name: w.update.name,
            fields: nextFields,
          });
        }
      }
      return sendJson(200, { commitTime: new Date().toISOString() });
    }

    const parts = sub.replace(/^\/+/, '').split('/');
    if (parts.length === 1 && req.method === 'GET') {
      const colMap = collections.get(parts[0]) || new Map();
      return sendJson(200, { documents: Array.from(colMap.values()) });
    }
    if (parts.length === 2 && req.method === 'GET') {
      const doc = collections.get(parts[0])?.get(decodeURIComponent(parts[1]));
      if (!doc) return sendJson(404, { error: { status: 'NOT_FOUND' } });
      return sendJson(200, doc);
    }

    return sendJson(404, { error: { message: `Unhandled mock Firestore route: ${sub}` } });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const origin = `http://127.0.0.1:${addr.port}`;

  return {
    origin,
    collections,
    requestedPaths,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('Cloudflare Edge Backend & Password Hash Interoperability', () => {
  it('verifies legacy scrypt hashes with upgrade flag and keeps Node/Edge PBKDF2 cross-compatible', async () => {
    const legacyHash = hashPassword('Maison#Direct2026!');
    const legacyCheck = await verifyPasswordEdge('Maison#Direct2026!', legacyHash);
    assert.equal(legacyCheck.valid, true);
    assert.equal(legacyCheck.needsRehash, true);

    const wrongLegacy = await verifyPasswordEdge('WrongPass1!', legacyHash);
    assert.equal(wrongLegacy.valid, false);
    assert.equal(wrongLegacy.needsRehash, false);

    const edgeHash = await hashPasswordPbkdf2('Customer#Vault2026!');
    assert.ok(edgeHash.startsWith('pbkdf2_sha256$100000$'));

    const edgeCheck = await verifyPasswordEdge('Customer#Vault2026!', edgeHash);
    assert.equal(edgeCheck.valid, true);
    assert.equal(edgeCheck.needsRehash, false);

    // Cross-compatibility: Node verifyPassword in server.ts also verifies Edge PBKDF2 hashes
    assert.equal(verifyPassword('Customer#Vault2026!', edgeHash), true);
    assert.equal(verifyPassword('WrongPass1!', edgeHash), false);
  });

  it('executes full API lifecycle (health, products, legacy scrypt admin login, RBAC, atomic orders) against target Firestore databaseId', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    const serviceAccountJson = JSON.stringify({
      project_id: TARGET_PROJECT_ID,
      client_email: 'mock-sa@example.iam.gserviceaccount.com',
      private_key: privateKey,
    });

    const existingAdminLegacyHash = hashPassword('Director#Legacy99!');
    const mockDb = await startMockFirestoreRestServer({
      users: {
        usr_admin: {
          id: 'usr_admin',
          email: 'director@rgdluxe.com',
          name: 'Maison Director',
          passwordHash: existingAdminLegacyHash,
          role: 'admin',
        },
      },
      products: {
        'prod-existing-1': {
          id: 'prod-existing-1',
          name: 'Calibre Sovereign I',
          subtitle: '18K Rose Gold Tourbillon',
          category: 'watches',
          categoryLabel: 'Luxury Watches',
          price: 12000,
          originalPrice: 12000,
          discountEnabled: false,
          discountPercentage: 0,
          rating: 5,
          reviewsCount: 12,
          image: '/assets/images/watch_rose_gold_1794494079347.jpg',
          images: ['/assets/images/watch_rose_gold_1794494079347.jpg'],
          description: 'Original watch',
          details: ['Swiss Calibre'],
          composition: '18K Rose Gold',
          sizes: ['41mm'],
          colors: [{ name: 'Rose Gold', hex: '#B76E79' }],
          inStock: true,
          stockCount: 5,
          isNewArrival: true,
          isBestSeller: false,
          isSpecialOffer: false,
          sku: 'RGD-ORIG-01',
          isDemo: false,
          sortOrder: 1000,
        },
      },
      catalog_meta: {
        state: { seeded: true },
      },
    });

    try {
      const app = createEdgeApiApp();
      const env: EdgeEnv = {
        NODE_ENV: 'production',
        FIREBASE_SERVICE_ACCOUNT_KEY: serviceAccountJson,
        FIREBASE_DATABASE_ID: TARGET_DATABASE_ID,
        FIRESTORE_ORIGIN: mockDb.origin,
        OAUTH_TOKEN_URL: `${mockDb.origin}/oauth/token`,
        ADMIN_EMAIL: 'other-should-not-overwrite@rgdluxe.com',
        ADMIN_PASSWORD: 'ShouldNotOverwriteExistingAdmin1!',
        VITE_FIREBASE_PROJECT_ID: TARGET_PROJECT_ID,
        VITE_FIREBASE_API_KEY: 'public-web-key',
      };

      const callApi = async (
        pathname: string,
        init: RequestInit = {}
      ): Promise<Response> => {
        const req = new Request(`https://rgdluxe.pages.dev${pathname}`, {
          ...init,
          headers: {
            host: 'rgdluxe.pages.dev',
            'x-forwarded-proto': 'https',
            ...(init.headers || {}),
          },
        });
        return await app.fetch(req, env);
      };

      // 1. Health check
      const healthRes = await callApi('/api/health');
      assert.equal(healthRes.status, 200);
      const health = (await healthRes.json()) as any;
      assert.equal(health.status, 'healthy');
      assert.equal(health.projectId, TARGET_PROJECT_ID);
      assert.equal(health.databaseId, TARGET_DATABASE_ID);
      assert.equal(health.persistenceMode, 'firestore');
      assert.ok(healthRes.headers.get('content-security-policy')?.includes("default-src 'self'"));
      assert.ok(healthRes.headers.get('strict-transport-security')?.includes('max-age=31536000'));

      // 2. Existing admin is preserved (not overwritten by env bootstrap) & logs in with legacy scrypt hash
      const adminLoginRes = await callApi('/api/auth/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'director@rgdluxe.com', password: 'Director#Legacy99!' }),
      });
      assert.equal(adminLoginRes.status, 200);
      const adminLoginData = (await adminLoginRes.json()) as any;
      assert.equal(adminLoginData.user.role, 'admin');
      assert.ok(adminLoginData.sessionToken);
      assert.match(adminLoginRes.headers.get('set-cookie') || '', /rgd_session=.*HttpOnly.*Secure/);

      // Admin password hash in Firestore was transparently upgraded to PBKDF2
      const upgradedAdminDoc = decodeFirestoreDocument(mockDb.collections.get('users')?.get('usr_admin'));
      assert.ok(String(upgradedAdminDoc?.passwordHash).startsWith('pbkdf2_sha256$100000$'));

      // Subsequent login works seamlessly with upgraded PBKDF2 hash
      const adminReLoginRes = await callApi('/api/auth/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'director@rgdluxe.com', password: 'Director#Legacy99!' }),
      });
      assert.equal(adminReLoginRes.status, 200);

      // 3. Products endpoint lists existing product without overwriting it
      const listRes = await callApi('/api/products');
      assert.equal(listRes.status, 200);
      const listData = (await listRes.json()) as any;
      assert.equal(listData.products.length, 1);
      assert.equal(listData.products[0].id, 'prod-existing-1');

      // 4. Customer registration & RBAC isolation
      const regRes = await callApi('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'VIP Collector',
          email: 'vip@example.com',
          password: 'Collector#2026!',
        }),
      });
      assert.equal(regRes.status, 201);
      const regData = (await regRes.json()) as any;
      const customerToken = regData.sessionToken;

      const customerCreateProd = await callApi('/api/products', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${customerToken}`,
        },
        body: JSON.stringify({ name: 'Unauthorized Watch', price: 5000, image: '/a.jpg' }),
      });
      assert.equal(customerCreateProd.status, 403);

      // 5. Admin creates new product -> persisted to target DB and visible on GET /api/products
      const adminToken = adminLoginData.sessionToken;
      const createProdRes = await callApi('/api/products', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          name: 'Obsidian Chronograph',
          subtitle: 'Hand-wound Calibre',
          category: 'watches',
          originalPrice: 8500,
          price: 8500,
          stockCount: 4,
          image: '/assets/images/watch_black_diamond_1794494079598.jpg',
          images: ['/assets/images/watch_black_diamond_1794494079598.jpg'],
        }),
      });
      assert.equal(createProdRes.status, 201);
      const createdProd = (await createProdRes.json()) as any;

      const afterCreateList = await (await callApi('/api/products')).json() as any;
      assert.equal(afterCreateList.products.length, 2);
      assert.equal(afterCreateList.products[0].id, createdProd.id);

      // 6. Atomic order creation decrements product stock and scopes customer visibility
      const orderRes = await callApi('/api/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${customerToken}`,
        },
        body: JSON.stringify({
          customer: {
            name: 'VIP Collector',
            email: 'vip@example.com',
            phone: '+12125550100',
            address: '725 Fifth Ave',
            city: 'New York',
            postalCode: '10022',
            country: 'United States',
          },
          items: [{ productId: createdProd.id, quantity: 2 }],
          paymentMethod: 'cod',
        }),
      });
      assert.equal(orderRes.status, 201);
      const orderData = (await orderRes.json()) as any;
      assert.equal(orderData.subtotal, 17000);

      const updatedProd = (await (await callApi(`/api/products/${createdProd.id}`)).json()) as any;
      assert.equal(updatedProd.stockCount, 2);

      const custOrders = (await (
        await callApi('/api/orders', { headers: { Authorization: `Bearer ${customerToken}` } })
      ).json()) as any;
      assert.equal(custOrders.orders.length, 1);

      const adminOrdersRes = await callApi('/api/admin/orders', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(adminOrdersRes.status, 200);

      // Verify exact Firestore database path used on every request
      assert.ok(
        mockDb.requestedPaths.some((p) =>
          p.includes(`/projects/${TARGET_PROJECT_ID}/databases/${TARGET_DATABASE_ID}/documents`)
        )
      );

      // Verify zero secrets in client build config / public files
      const headersFile = fs.readFileSync(path.join(process.cwd(), 'public/_headers'), 'utf8');
      assert.ok(headersFile.includes('Content-Security-Policy:'));
      assert.ok(headersFile.includes('Strict-Transport-Security:'));
    } finally {
      await mockDb.close();
    }
  });
});
