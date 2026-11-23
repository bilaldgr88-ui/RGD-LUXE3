import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deleteApp, initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { resolveFirebaseWebConfig } from '../firebase.ts';

const ROOT = process.cwd();

describe('Firebase Web Initialization Configuration', () => {
  it('accepts explicit VITE_FIREBASE_PROJECT_ID including ai-studio-applet-webapp-94ef6', async () => {
    const config = resolveFirebaseWebConfig({
      VITE_FIREBASE_PROJECT_ID: 'ai-studio-applet-webapp-94ef6',
      VITE_FIREBASE_API_KEY: 'AIzaSyTestPlaceholderKeyForUnitTestOnly123',
    });

    assert.ok(config, 'Expected explicit Firebase config to be resolved');
    assert.equal(config.projectId, 'ai-studio-applet-webapp-94ef6');
    assert.equal(config.apiKey, 'AIzaSyTestPlaceholderKeyForUnitTestOnly123');
    assert.equal(config.authDomain, 'ai-studio-applet-webapp-94ef6.firebaseapp.com');
    assert.equal(config.firestoreDatabaseId, '(default)');
    assert.equal(
      config.storageBucket,
      'ai-studio-applet-webapp-94ef6.firebasestorage.app'
    );

    const testApp = initializeApp(config, `test-app-${Date.now()}`);
    try {
      const testAuth = getAuth(testApp);
      const testDb = getFirestore(testApp, config.firestoreDatabaseId);
      assert.equal(testApp.options.projectId, 'ai-studio-applet-webapp-94ef6');
      assert.ok(testAuth, 'Expected Firebase Auth instance to initialize');
      assert.ok(testDb, 'Expected Firestore instance to initialize');
    } finally {
      await deleteApp(testApp);
    }
  });

  it('respects optional VITE_FIREBASE_* overrides when provided', () => {
    const config = resolveFirebaseWebConfig({
      VITE_FIREBASE_PROJECT_ID: 'ai-studio-applet-webapp-94ef6',
      VITE_FIREBASE_API_KEY: 'AIzaSyTestPlaceholderKeyForUnitTestOnly123',
      VITE_FIREBASE_APP_ID: '1:123456:web:abcdef',
      VITE_FIREBASE_AUTH_DOMAIN: 'auth.custom-domain.example',
      VITE_FIREBASE_DATABASE_ID: 'custom-db-id',
      VITE_FIREBASE_STORAGE_BUCKET: 'custom-bucket.appspot.com',
      VITE_FIREBASE_MESSAGING_SENDER_ID: '987654321',
    });

    assert.deepEqual(config, {
      projectId: 'ai-studio-applet-webapp-94ef6',
      apiKey: 'AIzaSyTestPlaceholderKeyForUnitTestOnly123',
      appId: '1:123456:web:abcdef',
      authDomain: 'auth.custom-domain.example',
      firestoreDatabaseId: 'custom-db-id',
      storageBucket: 'custom-bucket.appspot.com',
      messagingSenderId: '987654321',
    });
  });

  it('returns null when required explicit credentials are missing or blank', () => {
    assert.equal(resolveFirebaseWebConfig(undefined), null);
    assert.equal(resolveFirebaseWebConfig({}), null);
    assert.equal(
      resolveFirebaseWebConfig({
        VITE_FIREBASE_PROJECT_ID: 'ai-studio-applet-webapp-94ef6',
        VITE_FIREBASE_API_KEY: '   ',
      }),
      null
    );
    assert.equal(
      resolveFirebaseWebConfig({
        VITE_FIREBASE_PROJECT_ID: '',
        VITE_FIREBASE_API_KEY: 'AIzaSyTestPlaceholderKeyForUnitTestOnly123',
      }),
      null
    );
  });

  it('does not contain legacy project ID rejection or hardcoded secrets in src/firebase.ts', () => {
    const firebaseSrc = fs.readFileSync(path.join(ROOT, 'src/firebase.ts'), 'utf8');
    assert.equal(firebaseSrc.includes('LEGACY_APPLET_PROJECT_ID'), false);
    assert.equal(firebaseSrc.includes('ai-studio-applet-webapp-94ef6'), false);
    assert.equal(firebaseSrc.includes('AIza'), false);
    assert.equal(firebaseSrc.includes('firebase-applet-config.json'), false);
  });
});
