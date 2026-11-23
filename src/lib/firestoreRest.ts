import { decodeFirestoreDocument } from '../utils/productCatalog.ts';
import { base64UrlDecodeToBytes, signRs256Jwt } from '../utils/edgeCrypto.ts';

export const SERVER_TIMESTAMP_SENTINEL = { __firestoreSentinel: 'SERVER_TIMESTAMP' } as const;
export const DELETE_FIELD_SENTINEL = { __firestoreSentinel: 'DELETE_FIELD' } as const;

export interface ParsedEdgeServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export interface FirestoreRestConfig {
  serviceAccount: ParsedEdgeServiceAccount;
  databaseId: string;
  firestoreOrigin?: string;
  oauthTokenUrl?: string;
  jwkUrl?: string;
  fetcher?: typeof fetch;
}

export interface WhereFilter {
  field: string;
  op: 'EQUAL' | 'NOT_EQUAL' | 'LESS_THAN' | 'GREATER_THAN';
  value: string | number | boolean | null;
}

export interface FieldTransform {
  fieldPath: string;
  setToServerValue: 'REQUEST_TIME';
}

export interface CommitWrite {
  update?: {
    name: string;
    fields: Record<string, any>;
  };
  updateMask?: {
    fieldPaths: string[];
  };
  updateTransforms?: FieldTransform[];
  currentDocument?: {
    exists: boolean;
  };
  delete?: string;
}

interface TokenCacheEntry {
  accessToken: string;
  expiresAtMs: number;
}

interface JwkCacheEntry {
  keys: Record<string, any>[];
  expiresAtMs: number;
}

const accessTokenCache = new Map<string, TokenCacheEntry>();
const jwkCache = new Map<string, JwkCacheEntry>();

export function parseServiceAccountEdge(rawInput: string): ParsedEdgeServiceAccount | null {
  const trimmed = (rawInput || '').trim();
  if (!trimmed) return null;

  let jsonText = trimmed;
  if (!trimmed.startsWith('{')) {
    try {
      const normalized = trimmed.replace(/\s+/g, '');
      const decodedBytes = Uint8Array.from(atob(normalized), (c) => c.charCodeAt(0));
      const decoded = new TextDecoder().decode(decodedBytes).trim();
      if (decoded.startsWith('{')) {
        jsonText = decoded;
      }
    } catch {
      return null;
    }
  }

  try {
    const parsed = JSON.parse(jsonText) as Record<string, any>;
    const projectId = typeof parsed.project_id === 'string' ? parsed.project_id.trim() : '';
    const clientEmail = typeof parsed.client_email === 'string' ? parsed.client_email.trim() : '';
    let privateKey = typeof parsed.private_key === 'string' ? parsed.private_key : '';
    if (privateKey.includes('\\n')) {
      privateKey = privateKey.replace(/\\n/g, '\n');
    }

    if (!projectId || !clientEmail || !privateKey.includes('BEGIN PRIVATE KEY')) {
      return null;
    }

    return { projectId, clientEmail, privateKey };
  } catch {
    return null;
  }
}

function escapeFieldPathSegment(seg: string): string {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(seg) ? seg : `\`${seg.replace(/`/g, '\\`')}\``;
}

function joinFieldPath(parent: string, key: string): string {
  const seg = escapeFieldPathSegment(key);
  return parent ? `${parent}.${seg}` : seg;
}

export function encodeFirestoreValue(
  val: any,
  fieldPath = '',
  transforms?: FieldTransform[]
): any {
  if (val === null) {
    return { nullValue: null };
  }
  if (val === SERVER_TIMESTAMP_SENTINEL) {
    if (transforms && fieldPath) {
      transforms.push({ fieldPath, setToServerValue: 'REQUEST_TIME' });
    }
    return undefined;
  }
  if (val === DELETE_FIELD_SENTINEL) {
    return undefined;
  }
  if (typeof val === 'boolean') {
    return { booleanValue: val };
  }
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) {
      return { doubleValue: 0 };
    }
    if (Number.isInteger(val) && Math.abs(val) <= Number.MAX_SAFE_INTEGER) {
      return { integerValue: String(val) };
    }
    return { doubleValue: val };
  }
  if (typeof val === 'string') {
    return { stringValue: val };
  }
  if (val instanceof Date) {
    return { timestampValue: val.toISOString() };
  }
  if (Array.isArray(val)) {
    const encodedValues: any[] = [];
    for (const item of val) {
      if (item === undefined || item === DELETE_FIELD_SENTINEL || item === SERVER_TIMESTAMP_SENTINEL) {
        continue;
      }
      const enc = encodeFirestoreValue(item);
      if (enc !== undefined) {
        encodedValues.push(enc);
      }
    }
    return { arrayValue: { values: encodedValues } };
  }
  if (typeof val === 'object') {
    const fields: Record<string, any> = {};
    for (const [k, child] of Object.entries(val)) {
      if (child === undefined) continue;
      const childPath = joinFieldPath(fieldPath, k);
      const enc = encodeFirestoreValue(child, childPath, transforms);
      if (enc !== undefined) {
        fields[k] = enc;
      }
    }
    return { mapValue: { fields } };
  }
  return undefined;
}

export function prepareFirestoreDocumentData(data: Record<string, any>): {
  fields: Record<string, any>;
  updateTransforms: FieldTransform[];
  maskFieldPaths: string[];
} {
  const fields: Record<string, any> = {};
  const updateTransforms: FieldTransform[] = [];
  const maskFieldPaths: string[] = [];

  for (const [key, val] of Object.entries(data)) {
    if (val === undefined) continue;
    const fieldPath = joinFieldPath('', key);
    if (val === DELETE_FIELD_SENTINEL) {
      maskFieldPaths.push(fieldPath);
      continue;
    }
    if (val === SERVER_TIMESTAMP_SENTINEL) {
      updateTransforms.push({ fieldPath, setToServerValue: 'REQUEST_TIME' });
      continue;
    }
    const enc = encodeFirestoreValue(val, fieldPath, updateTransforms);
    if (enc !== undefined) {
      fields[key] = enc;
      maskFieldPaths.push(fieldPath);
    }
  }

  return { fields, updateTransforms, maskFieldPaths };
}

export class FirestoreRestTransaction {
  private writes: CommitWrite[] = [];
  constructor(
    private client: FirestoreRestClient,
    public readonly transactionId: string
  ) {}

  async get(collectionPath: string, docId: string): Promise<Record<string, any> | null> {
    return await this.client.getDoc(collectionPath, docId, this.transactionId);
  }

  async batchGet(docRefs: Array<{ collection: string; id: string }>): Promise<Map<string, Record<string, any>>> {
    return await this.client.batchGetDocs(docRefs, this.transactionId);
  }

  async query(collectionPath: string, where?: WhereFilter[], limit?: number): Promise<Record<string, any>[]> {
    return await this.client.runQuery({
      collection: collectionPath,
      where,
      limit,
      transactionId: this.transactionId,
    });
  }

  set(
    collectionPath: string,
    docId: string,
    data: Record<string, any>,
    options?: { merge?: boolean }
  ): void {
    const docName = this.client.documentResourceName(collectionPath, docId);
    const { fields, updateTransforms, maskFieldPaths } = prepareFirestoreDocumentData(data);
    const write: CommitWrite = {
      update: {
        name: docName,
        fields,
      },
    };
    if (options?.merge) {
      write.updateMask = { fieldPaths: maskFieldPaths };
    }
    if (updateTransforms.length > 0) {
      write.updateTransforms = updateTransforms;
    }
    this.writes.push(write);
  }

  update(collectionPath: string, docId: string, patch: Record<string, any>): void {
    this.set(collectionPath, docId, patch, { merge: true });
  }

  delete(collectionPath: string, docId: string): void {
    this.writes.push({
      delete: this.client.documentResourceName(collectionPath, docId),
    });
  }

  getPendingWrites(): CommitWrite[] {
    return this.writes;
  }
}

export class FirestoreRestClient {
  public readonly projectId: string;
  public readonly databaseId: string;
  private readonly clientEmail: string;
  private readonly privateKey: string;
  private readonly firestoreOrigin: string;
  private readonly oauthTokenUrl: string;
  private readonly jwkUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(config: FirestoreRestConfig) {
    this.projectId = config.serviceAccount.projectId;
    this.clientEmail = config.serviceAccount.clientEmail;
    this.privateKey = config.serviceAccount.privateKey;
    this.databaseId = (config.databaseId || '(default)').trim() || '(default)';
    this.firestoreOrigin = (config.firestoreOrigin || 'https://firestore.googleapis.com').replace(/\/+$/, '');
    this.oauthTokenUrl = config.oauthTokenUrl || 'https://oauth2.googleapis.com/token';
    this.jwkUrl =
      config.jwkUrl ||
      'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
    this.fetcher = config.fetcher || ((input, init) => fetch(input, init));
  }

  get documentsRootPath(): string {
    return `projects/${this.projectId}/databases/${this.databaseId}/documents`;
  }

  get documentsBaseUrl(): string {
    return `${this.firestoreOrigin}/v1/projects/${encodeURIComponent(
      this.projectId
    )}/databases/${encodeURIComponent(this.databaseId)}/documents`;
  }

  documentResourceName(collectionPath: string, docId: string): string {
    return `${this.documentsRootPath}/${collectionPath}/${docId}`;
  }

  async getAccessToken(): Promise<string> {
    const cacheKey = `${this.projectId}:${this.clientEmail}:${this.oauthTokenUrl}`;
    const cached = accessTokenCache.get(cacheKey);
    const nowMs = Date.now();
    if (cached && cached.expiresAtMs - 60_000 > nowMs) {
      return cached.accessToken;
    }

    const nowSec = Math.floor(nowMs / 1000);
    const assertion = await signRs256Jwt(
      {
        iss: this.clientEmail,
        scope:
          'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/userinfo.email',
        aud: this.oauthTokenUrl,
        iat: nowSec,
        exp: nowSec + 3600,
      },
      this.privateKey
    );

    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });

    const res = await this.fetcher(this.oauthTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Google OAuth2 token exchange failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      throw new Error('Google OAuth2 response missing access_token.');
    }

    const ttlMs = Math.max(120, Number(data.expires_in || 3600)) * 1000;
    accessTokenCache.set(cacheKey, {
      accessToken: data.access_token,
      expiresAtMs: nowMs + ttlMs,
    });

    return data.access_token;
  }

  private async authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.getAccessToken();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    return await this.fetcher(url, { ...init, headers });
  }

  async getDoc(
    collectionPath: string,
    docId: string,
    transactionId?: string
  ): Promise<Record<string, any> | null> {
    const url = new URL(`${this.documentsBaseUrl}/${collectionPath}/${encodeURIComponent(docId)}`);
    if (transactionId) {
      url.searchParams.set('transaction', transactionId);
    }
    const res = await this.authedFetch(url.toString(), { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Firestore getDoc(${collectionPath}/${docId}) failed (${res.status}): ${errText}`);
    }
    const doc = await res.json();
    return decodeFirestoreDocument(doc);
  }

  async batchGetDocs(
    docRefs: Array<{ collection: string; id: string }>,
    transactionId?: string
  ): Promise<Map<string, Record<string, any>>> {
    const result = new Map<string, Record<string, any>>();
    if (docRefs.length === 0) return result;

    const payload: Record<string, any> = {
      documents: docRefs.map((r) => this.documentResourceName(r.collection, r.id)),
    };
    if (transactionId) {
      payload.transaction = transactionId;
    }

    const res = await this.authedFetch(`${this.documentsBaseUrl}:batchGet`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Firestore batchGet failed (${res.status}): ${errText}`);
    }

    const rows = (await res.json()) as Array<{ found?: any; missing?: string }>;
    if (!Array.isArray(rows)) return result;

    for (const row of rows) {
      if (row?.found) {
        const decoded = decodeFirestoreDocument(row.found);
        if (decoded && decoded.id) {
          result.set(String(decoded.id), decoded);
        } else if (decoded && typeof row.found.name === 'string') {
          const parts = row.found.name.split('/');
          const docId = parts[parts.length - 1];
          result.set(docId, { ...decoded, id: docId });
        }
      }
    }
    return result;
  }

  async listDocs(collectionPath: string, pageSize = 300): Promise<Record<string, any>[]> {
    const out: Record<string, any>[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(`${this.documentsBaseUrl}/${collectionPath}`);
      url.searchParams.set('pageSize', String(pageSize));
      if (pageToken) {
        url.searchParams.set('pageToken', pageToken);
      }

      const res = await this.authedFetch(url.toString(), { method: 'GET' });
      if (res.status === 404) return [];
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Firestore listDocs(${collectionPath}) failed (${res.status}): ${errText}`);
      }

      const data = (await res.json()) as { documents?: any[]; nextPageToken?: string };
      if (Array.isArray(data.documents)) {
        for (const rawDoc of data.documents) {
          const decoded = decodeFirestoreDocument(rawDoc);
          if (decoded) out.push(decoded);
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken);

    return out;
  }

  async runQuery(params: {
    collection: string;
    where?: WhereFilter[];
    limit?: number;
    transactionId?: string;
  }): Promise<Record<string, any>[]> {
    const structuredQuery: Record<string, any> = {
      from: [{ collectionId: params.collection }],
    };

    if (params.where && params.where.length > 0) {
      const filters = params.where.map((f) => ({
        fieldFilter: {
          field: { fieldPath: f.field },
          op: f.op,
          value: encodeFirestoreValue(f.value),
        },
      }));
      structuredQuery.where =
        filters.length === 1
          ? filters[0]
          : { compositeFilter: { op: 'AND', filters } };
    }

    if (params.limit !== undefined) {
      structuredQuery.limit = params.limit;
    }

    const body: Record<string, any> = { structuredQuery };
    if (params.transactionId) {
      body.transaction = params.transactionId;
    }

    const res = await this.authedFetch(`${this.documentsBaseUrl}:runQuery`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Firestore runQuery(${params.collection}) failed (${res.status}): ${errText}`);
    }

    const rows = (await res.json()) as Array<{ document?: any }>;
    if (!Array.isArray(rows)) return [];

    const decodedRows: Record<string, any>[] = [];
    for (const row of rows) {
      if (row?.document) {
        const decoded = decodeFirestoreDocument(row.document);
        if (decoded) decodedRows.push(decoded);
      }
    }
    return decodedRows;
  }

  async commitWrites(writes: CommitWrite[], transactionId?: string): Promise<void> {
    if (writes.length === 0 && !transactionId) return;
    const payload: Record<string, any> = { writes };
    if (transactionId) {
      payload.transaction = transactionId;
    }

    const res = await this.authedFetch(`${this.documentsBaseUrl}:commit`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const err = new Error(`Firestore commit failed (${res.status}): ${errText}`) as Error & {
        status?: number;
      };
      err.status = res.status;
      throw err;
    }
  }

  async createDocIfMissing(
    collectionPath: string,
    docId: string,
    data: Record<string, any>
  ): Promise<boolean> {
    const docName = this.documentResourceName(collectionPath, docId);
    const { fields, updateTransforms } = prepareFirestoreDocumentData(data);
    const write: CommitWrite = {
      update: { name: docName, fields },
      currentDocument: { exists: false },
    };
    if (updateTransforms.length > 0) {
      write.updateTransforms = updateTransforms;
    }

    try {
      await this.commitWrites([write]);
      return true;
    } catch (err: any) {
      if (err?.status === 409 || /ALREADY_EXISTS/i.test(String(err?.message || ''))) {
        return false;
      }
      throw err;
    }
  }

  async setDoc(
    collectionPath: string,
    docId: string,
    data: Record<string, any>,
    options?: { merge?: boolean }
  ): Promise<void> {
    const docName = this.documentResourceName(collectionPath, docId);
    const { fields, updateTransforms, maskFieldPaths } = prepareFirestoreDocumentData(data);
    const write: CommitWrite = {
      update: { name: docName, fields },
    };
    if (options?.merge) {
      write.updateMask = { fieldPaths: maskFieldPaths };
    }
    if (updateTransforms.length > 0) {
      write.updateTransforms = updateTransforms;
    }
    await this.commitWrites([write]);
  }

  async deleteDoc(collectionPath: string, docId: string): Promise<void> {
    await this.commitWrites([{ delete: this.documentResourceName(collectionPath, docId) }]);
  }

  async runTransaction<T>(fn: (tx: FirestoreRestTransaction) => Promise<T>): Promise<T> {
    const maxAttempts = 3;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const beginRes = await this.authedFetch(`${this.documentsBaseUrl}:beginTransaction`, {
        method: 'POST',
        body: JSON.stringify({ options: { readWrite: {} } }),
      });
      if (!beginRes.ok) {
        const errText = await beginRes.text().catch(() => '');
        throw new Error(`Firestore beginTransaction failed (${beginRes.status}): ${errText}`);
      }
      const beginData = (await beginRes.json()) as { transaction?: string };
      const transactionId = beginData.transaction;
      if (!transactionId) {
        throw new Error('Firestore beginTransaction did not return a transaction handle.');
      }

      const tx = new FirestoreRestTransaction(this, transactionId);
      try {
        const result = await fn(tx);
        const pendingWrites = tx.getPendingWrites();
        if (pendingWrites.length > 0) {
          await this.commitWrites(pendingWrites, transactionId);
        } else {
          await this.authedFetch(`${this.documentsBaseUrl}:rollback`, {
            method: 'POST',
            body: JSON.stringify({ transaction: transactionId }),
          }).catch(() => {});
        }
        return result;
      } catch (err: any) {
        await this.authedFetch(`${this.documentsBaseUrl}:rollback`, {
          method: 'POST',
          body: JSON.stringify({ transaction: transactionId }),
        }).catch(() => {});

        lastErr = err;
        const isAborted = err?.status === 409 || /ABORTED/i.test(String(err?.message || ''));
        if (isAborted && attempt < maxAttempts) {
          continue;
        }
        throw err;
      }
    }

    throw lastErr;
  }

  async verifyConnectivity(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.getDoc('app_settings', 'connectivity_probe');
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Firestore REST connectivity check failed.' };
    }
  }

  async verifyFirebaseIdToken(idToken: string): Promise<{
    uid: string;
    email?: string;
    email_verified?: boolean;
  }> {
    const parts = (idToken || '').trim().split('.');
    if (parts.length !== 3) {
      throw new Error('Malformed Firebase ID token.');
    }

    const header = JSON.parse(new TextDecoder().decode(base64UrlDecodeToBytes(parts[0]))) as {
      alg?: string;
      kid?: string;
    };
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecodeToBytes(parts[1]))) as {
      aud?: string;
      iss?: string;
      sub?: string;
      exp?: number;
      iat?: number;
      email?: string;
      email_verified?: boolean;
    };

    if (header.alg !== 'RS256' || !header.kid) {
      throw new Error('Invalid Firebase ID token signing header.');
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.aud !== this.projectId) {
      throw new Error('Firebase ID token audience does not match project.');
    }
    if (payload.iss !== `https://securetoken.google.com/${this.projectId}`) {
      throw new Error('Firebase ID token issuer mismatch.');
    }
    if (!payload.sub || typeof payload.sub !== 'string' || payload.sub.length > 128) {
      throw new Error('Firebase ID token missing valid subject.');
    }
    if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
      throw new Error('Firebase ID token has expired.');
    }
    if (typeof payload.iat !== 'number' || payload.iat > nowSec + 300) {
      throw new Error('Firebase ID token issued-at time is invalid.');
    }

    const keys = await this.getGooglePublicJwks();
    const matchingKey = keys.find((k) => k.kid === header.kid);
    if (!matchingKey) {
      throw new Error('Unable to find matching Google public signing key.');
    }

    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      matchingKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const signingData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sigBytes = base64UrlDecodeToBytes(parts[2]);
    const verified = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      new Uint8Array(sigBytes),
      signingData
    );
    if (!verified) {
      throw new Error('Firebase ID token signature verification failed.');
    }

    return {
      uid: payload.sub,
      email: payload.email,
      email_verified: payload.email_verified,
    };
  }

  private async getGooglePublicJwks(): Promise<Record<string, any>[]> {
    const cached = jwkCache.get(this.jwkUrl);
    const nowMs = Date.now();
    if (cached && cached.expiresAtMs > nowMs) {
      return cached.keys;
    }

    const res = await this.fetcher(this.jwkUrl, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`Failed to fetch Google JWKs (${res.status}).`);
    }

    const data = (await res.json()) as { keys?: Record<string, any>[] };
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const cacheControl = res.headers.get('cache-control') || '';
    const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
    const ttlMs = maxAgeMatch ? Math.max(60, Number(maxAgeMatch[1])) * 1000 : 300_000;

    jwkCache.set(this.jwkUrl, { keys, expiresAtMs: nowMs + ttlMs });
    return keys;
  }

  async setCustomAdminClaimBestEffort(uid: string): Promise<boolean> {
    try {
      const token = await this.getAccessToken();
      const lookupUrl = `https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(
        this.projectId
      )}/accounts:lookup`;
      const lookupRes = await this.fetcher(lookupUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ localId: [uid] }),
      });
      if (!lookupRes.ok) return false;
      const lookupData = (await lookupRes.json()) as {
        users?: Array<{ customAttributes?: string }>;
      };
      const existingRaw = lookupData.users?.[0]?.customAttributes;
      let existingClaims: Record<string, any> = {};
      if (existingRaw) {
        try {
          existingClaims = JSON.parse(existingRaw);
        } catch {
          existingClaims = {};
        }
      }
      const nextClaims = JSON.stringify({ ...existingClaims, admin: true });

      const updateUrl = `https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(
        this.projectId
      )}/accounts:update`;
      const updateRes = await this.fetcher(updateUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          localId: uid,
          customAttributes: nextClaims,
        }),
      });
      return updateRes.ok;
    } catch {
      return false;
    }
  }
}
