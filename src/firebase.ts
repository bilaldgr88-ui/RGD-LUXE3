import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';

const env = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : ({} as Record<string, any>);

const LEGACY_APPLET_PROJECT_ID = 'ai-studio-applet-webapp-94ef6';
const explicitProjectId = String(env.VITE_FIREBASE_PROJECT_ID || '').trim();
const explicitApiKey = String(env.VITE_FIREBASE_API_KEY || '').trim();

export const hasExplicitTargetWebConfig = Boolean(
  explicitProjectId &&
  explicitApiKey &&
  explicitProjectId !== LEGACY_APPLET_PROJECT_ID
);

const firebaseConfig = hasExplicitTargetWebConfig
  ? {
      projectId: explicitProjectId,
      appId: String(env.VITE_FIREBASE_APP_ID || ''),
      apiKey: explicitApiKey,
      authDomain: String(env.VITE_FIREBASE_AUTH_DOMAIN || `${explicitProjectId}.firebaseapp.com`),
      firestoreDatabaseId: String(env.VITE_FIREBASE_DATABASE_ID || '(default)'),
      storageBucket: String(env.VITE_FIREBASE_STORAGE_BUCKET || `${explicitProjectId}.firebasestorage.app`),
      messagingSenderId: String(env.VITE_FIREBASE_MESSAGING_SENDER_ID || ''),
    }
  : null;

const app: FirebaseApp | null = firebaseConfig ? initializeApp(firebaseConfig) : null;
export const db: Firestore | null =
  app && firebaseConfig ? getFirestore(app, firebaseConfig.firestoreDatabaseId || '(default)') : null;
export const auth: Auth | null = app ? getAuth(app) : null;
export const googleProvider: GoogleAuthProvider | null = app ? new GoogleAuthProvider() : null;
if (googleProvider) {
  googleProvider.setCustomParameters({ prompt: 'select_account' });
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth?.currentUser?.uid,
      email: auth?.currentUser?.email,
      emailVerified: auth?.currentUser?.emailVerified,
      isAnonymous: auth?.currentUser?.isAnonymous,
      tenantId: auth?.currentUser?.tenantId,
      providerInfo:
        auth?.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

