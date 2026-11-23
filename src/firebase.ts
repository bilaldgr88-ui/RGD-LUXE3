import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';

export interface ExplicitFirebaseWebConfig {
  projectId: string;
  appId: string;
  apiKey: string;
  authDomain: string;
  firestoreDatabaseId: string;
  storageBucket: string;
  messagingSenderId: string;
}

export function resolveFirebaseWebConfig(
  rawEnv: Record<string, any> | undefined
): ExplicitFirebaseWebConfig | null {
  if (!rawEnv) return null;
  const explicitProjectId = String(rawEnv.VITE_FIREBASE_PROJECT_ID || '').trim();
  const explicitApiKey = String(rawEnv.VITE_FIREBASE_API_KEY || '').trim();
  if (!explicitProjectId || !explicitApiKey) {
    return null;
  }

  return {
    projectId: explicitProjectId,
    appId: String(rawEnv.VITE_FIREBASE_APP_ID || '').trim(),
    apiKey: explicitApiKey,
    authDomain:
      String(rawEnv.VITE_FIREBASE_AUTH_DOMAIN || '').trim() ||
      `${explicitProjectId}.firebaseapp.com`,
    firestoreDatabaseId:
      String(rawEnv.VITE_FIREBASE_DATABASE_ID || '').trim() || '(default)',
    storageBucket:
      String(rawEnv.VITE_FIREBASE_STORAGE_BUCKET || '').trim() ||
      `${explicitProjectId}.firebasestorage.app`,
    messagingSenderId: String(rawEnv.VITE_FIREBASE_MESSAGING_SENDER_ID || '').trim(),
  };
}

const env = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : ({} as Record<string, any>);

const firebaseConfig = resolveFirebaseWebConfig(env);
export const hasExplicitTargetWebConfig = Boolean(firebaseConfig);

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

