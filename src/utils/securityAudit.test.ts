import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseServiceAccountInput, resetFirebaseAdminCacheForTests } from '../lib/firebaseAdmin.ts';
import { subscriberDocId } from '../lib/migrateDbToFirestore.ts';
import { StoreRepository } from '../lib/storeRepository.ts';
import { isBlockedHttpPath } from './httpSecurity.ts';

const ROOT = process.cwd();

describe('RGD LUXE Security & Firestore Rules Audit', () => {
  it('firestore.rules contains no hardcoded admin email and enforces verified custom claim or /admins/{uid} RBAC', () => {
    const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');

    assert.equal(rules.includes('bilaldgr88@gmail.com'), false);
    assert.equal(rules.includes('admin@rgdluxe.com'), false);
    assert.equal(rules.includes('isBootstrappedAdmin'), false);
    assert.ok(rules.includes("rules_version = '2';"));
    assert.ok(rules.includes('allow read, write: if false;'));
    assert.ok(rules.includes('request.auth.token.email_verified == true'));
    assert.ok(rules.includes('request.auth.token.admin == true'));
    assert.ok(rules.includes('exists(/databases/$(database)/documents/admins/$(request.auth.uid))'));
    assert.ok(rules.includes('allow create, update, delete: if false;'));

    for (const privCol of [
      '/users/{userId}',
      '/orders/{orderId}',
      '/sessions/{sessionId}',
      '/password_reset_otps/{otpId}',
      '/subscribers/{subId}',
      '/contact_messages/{msgId}',
      '/app_settings/{settingId}',
    ]) {
      assert.ok(rules.includes(`match ${privCol}`), `Missing explicit private rule for ${privCol}`);
    }
  });

  it('client code contains no hardcoded admin emails, legacy applet fallback, or backend secret env keys', () => {
    const firestoreCatalog = fs.readFileSync(path.join(ROOT, 'src/utils/firestoreCatalog.ts'), 'utf8');
    const adminDashboard = fs.readFileSync(path.join(ROOT, 'src/pages/AdminDashboard.tsx'), 'utf8');
    const clientFirebase = fs.readFileSync(path.join(ROOT, 'src/firebase.ts'), 'utf8');
    const serverCode = fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf8');

    assert.equal(firestoreCatalog.includes('bilaldgr88@gmail.com'), false);
    assert.equal(firestoreCatalog.includes('BOOTSTRAPPED_CLOUD_ADMIN_EMAIL'), false);
    assert.equal(adminDashboard.includes('bilaldgr88@gmail.com'), false);
    assert.equal(adminDashboard.includes('BOOTSTRAPPED_CLOUD_ADMIN_EMAIL'), false);
    assert.equal(adminDashboard.includes('process.env'), false);
    assert.equal(adminDashboard.includes('SESSION_SECRET'), false);
    assert.equal(clientFirebase.includes('firebase-applet-config.json'), false);
    assert.equal(clientFirebase.includes('legacyAppletConfig'), false);
    assert.equal(serverCode.includes('firebase-applet-config.json'), false);
    assert.equal(serverCode.includes('dotenv.config({ override: true })'), false);
    assert.ok(serverCode.includes("process.env.NODE_ENV !== 'production'"));
    assert.equal(/\bre_[A-Za-z0-9_]{10,}/.test(adminDashboard), false);
    assert.equal(/\bre_[A-Za-z0-9_]{10,}/.test(firestoreCatalog), false);
  });

  it('.gitignore protects .env* and data/db.json while allowing .env.example', () => {
    const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    assert.ok(gitignore.includes('.env*'));
    assert.ok(gitignore.includes('!.env.example'));
    assert.ok(gitignore.includes('data/db.json'));
  });

  it('parseServiceAccountInput validates raw JSON and base64 formats safely and rejects malformed inputs', () => {
    const sample = JSON.stringify({
      project_id: 'rgd-luxe3',
      client_email: 'firebase-admin@rgd-luxe3.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\\nTEST\\n-----END PRIVATE KEY-----\\n',
    });
    const parsedRaw = parseServiceAccountInput(sample);
    assert.equal(parsedRaw?.projectId, 'rgd-luxe3');
    assert.ok(parsedRaw?.privateKey.includes('\nTEST\n'));

    const b64 = Buffer.from(sample, 'utf8').toString('base64');
    const parsedB64 = parseServiceAccountInput(b64);
    assert.equal(parsedB64?.projectId, 'rgd-luxe3');

    assert.equal(parseServiceAccountInput('not-valid-json'), null);
    assert.equal(parseServiceAccountInput('{"project_id":"x"}'), null);
  });

  it('subscriberDocId produces deterministic idempotent document IDs regardless of email casing', () => {
    assert.equal(subscriberDocId('Client@Example.com '), subscriberDocId('client@example.com'));
  });

  it('isBlockedHttpPath blocks data/db.json, server.ts, scripts, dotfiles, and traversal bypasses while allowing storefront assets', () => {
    const blocked = [
      '/data/db.json',
      '/data%2Fdb.json',
      '/public/../data/db.json',
      '//DATA//db.json',
      '/@fs/app/applet/data/db.json',
      '/server.ts',
      '/server.ts?raw',
      '/@fs/app/applet/server.ts',
      '/scripts/migrate-to-firestore.ts',
      '/src/lib/firebaseAdmin.ts',
      '/.env',
      '/.env.production',
      '/firebase-applet-config.json',
      '/firestore.rules',
      '/firebase-blueprint.json',
      '/package.json',
      '/.git/config',
    ];
    for (const p of blocked) {
      assert.equal(isBlockedHttpPath(p), true, `Expected path to be blocked: ${p}`);
    }

    const allowed = [
      '/',
      '/api/products',
      '/api/health',
      '/src/App.tsx',
      '/src/data/seedData.ts',
      '/src/assets/watch.jpg',
      '/uploads/products/watch-1.jpg',
    ];
    for (const p of allowed) {
      assert.equal(isBlockedHttpPath(p), false, `Expected path to be allowed: ${p}`);
    }
  });

  it('StoreRepository.init({ requireFirestore: true }) fails closed when Firebase Admin key is absent', async () => {
    const prevKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    const prevCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-failclosed-'));
    try {
      delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      resetFirebaseAdminCacheForTests();

      const repo = new StoreRepository(path.join(tmpDir, 'db.json'));
      await assert.rejects(
        () => repo.init({ requireFirestore: true }),
        /Production fail-closed abort/
      );
      assert.equal(fs.existsSync(path.join(tmpDir, 'db.json')), false);
    } finally {
      if (prevKey !== undefined) process.env.FIREBASE_SERVICE_ACCOUNT_KEY = prevKey;
      else delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
      if (prevCreds !== undefined) process.env.GOOGLE_APPLICATION_CREDENTIALS = prevCreds;
      else delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      resetFirebaseAdminCacheForTests();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('StoreRepository.listOrdersForCustomer isolates unowned guest orders from unverified accounts matching email', async () => {
    const prevKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    const prevCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgd-order-iso-'));
    const tmpDb = path.join(tmpDir, 'db.json');

    try {
      delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      resetFirebaseAdminCacheForTests();

      const repo = new StoreRepository(tmpDb);
      await repo.init({ requireFirestore: false });
      const products = await repo.listProducts();
      assert.ok(products.length > 0);

      // Guest checkout order (no userId) for target victim email
      const guestRes = await repo.createOrderTransaction({
        items: [{ productId: products[0].id, quantity: 1 }],
        customer: {
          name: 'Guest Victim',
          email: 'vip-guest@example.com',
          phone: '+1 212 555 0101',
          address: '10 Fifth Ave',
          city: 'New York',
          postalCode: '10001',
          country: 'United States',
        },
        paymentMethod: 'cod',
      });
      assert.ok(guestRes.order);
      assert.equal(guestRes.order.userId, undefined);

      // Authenticated customer order explicitly owned by usr_real_owner (even using a different delivery email)
      const ownedRes = await repo.createOrderTransaction({
        items: [{ productId: products[0].id, quantity: 1 }],
        userId: 'usr_real_owner',
        customer: {
          name: 'Signed Customer',
          email: 'recipient-other@example.com',
          phone: '+1 212 555 0102',
          address: '20 Madison Ave',
          city: 'New York',
          postalCode: '10010',
          country: 'United States',
        },
        paymentMethod: 'cod',
      });
      assert.ok(ownedRes.order);

      // Unverified attacker registers using guest's email -> gets brand new usr_attacker ID -> MUST see 0 orders
      const attackerOrders = await repo.listOrdersForCustomer('usr_attacker');
      assert.equal(attackerOrders.length, 0);

      // Real signed-in owner MUST still see their owned order
      const ownerOrders = await repo.listOrdersForCustomer('usr_real_owner');
      assert.equal(ownerOrders.length, 1);
      assert.equal(ownerOrders[0].id, ownedRes.order.id);
    } finally {
      if (prevKey !== undefined) process.env.FIREBASE_SERVICE_ACCOUNT_KEY = prevKey;
      else delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
      if (prevCreds !== undefined) process.env.GOOGLE_APPLICATION_CREDENTIALS = prevCreds;
      else delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      resetFirebaseAdminCacheForTests();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
