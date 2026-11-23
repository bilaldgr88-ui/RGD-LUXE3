import type { OtpRecord } from './authSecurity.ts';

export const PBKDF2_ITERATIONS = 100_000;
export const OTP_EXPIRY_MS = 5 * 60 * 1000;
export const MAX_OTP_ATTEMPTS = 5;
export const ADMIN_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
export const CUSTOMER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const textEncoder = new TextEncoder();

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export function hexToBytes(hex: string): Uint8Array | null {
  const clean = (hex || '').trim();
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    return null;
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export function randomHex(byteLength: number): string {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

export function generateOtpCodeEdge(): string {
  // Rejection sampling in [0, 900000) to avoid modulo bias
  const limit = Math.floor(0x100000000 / 900_000) * 900_000;
  const buf = new Uint32Array(1);
  while (true) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) {
      return String(100_000 + (buf[0] % 900_000));
    }
  }
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(input));
  return bytesToHex(new Uint8Array(digest));
}

export async function generateSessionTokenEdge(): Promise<{ token: string; tokenHash: string }> {
  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  return { token, tokenHash };
}

export async function hmacSha256Hex(keyString: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(keyString),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, textEncoder.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

export async function hashOtpCodeEdge(
  otp: string,
  existingSalt?: string
): Promise<{ salt: string; hash: string }> {
  const salt = existingSalt || randomHex(16);
  const hash = await hmacSha256Hex(salt, otp.trim());
  return { salt, hash };
}

export async function verifyOtpHashEdge(
  otp: string,
  salt: string,
  expectedHash: string
): Promise<boolean> {
  if (!otp || !salt || !expectedHash) return false;
  const expectedBytes = hexToBytes(expectedHash);
  if (!expectedBytes) return false;
  const { hash } = await hashOtpCodeEdge(otp, salt);
  const actualBytes = hexToBytes(hash);
  if (!actualBytes) return false;
  return timingSafeEqualBytes(actualBytes, expectedBytes);
}

export async function createOtpRecordEdge(
  userId: string,
  email: string,
  now = Date.now()
): Promise<{ otp: string; record: OtpRecord }> {
  const otp = generateOtpCodeEdge();
  const { salt, hash } = await hashOtpCodeEdge(otp);
  const record: OtpRecord = {
    id: `otp_${randomHex(8)}`,
    userId,
    email: email.trim().toLowerCase(),
    otpSalt: salt,
    otpHash: hash,
    createdAt: now,
    expiresAt: now + OTP_EXPIRY_MS,
    attempts: 0,
    used: false,
  };
  return { otp, record };
}

export async function verifyOtpAttemptEdge(
  records: OtpRecord[],
  email: string,
  otpInput: string,
  now = Date.now()
): Promise<{
  success: boolean;
  error?: string;
  resetGrantToken?: string;
}> {
  const cleanEmail = (email || '').trim().toLowerCase();
  const active = [...records].reverse().find((r) => r.email === cleanEmail && !r.used);

  if (!active) {
    return { success: false, error: 'Invalid or expired verification code.' };
  }

  if (now > active.expiresAt) {
    active.used = true;
    return { success: false, error: 'Verification code has expired. Please request a new code.' };
  }

  if (active.attempts >= MAX_OTP_ATTEMPTS) {
    active.used = true;
    return { success: false, error: 'Maximum verification attempts exceeded. Please request a new code.' };
  }

  active.attempts += 1;

  const matches = await verifyOtpHashEdge((otpInput || '').trim(), active.otpSalt, active.otpHash);
  if (!matches) {
    if (active.attempts >= MAX_OTP_ATTEMPTS) {
      active.used = true;
      return { success: false, error: 'Maximum verification attempts exceeded. Code invalidated.' };
    }
    return { success: false, error: 'Invalid verification code.' };
  }

  active.used = true;
  const grant = await generateSessionTokenEdge();
  active.resetGrantTokenHash = grant.tokenHash;
  active.resetGrantExpiresAt = now + OTP_EXPIRY_MS;

  return { success: true, resetGrantToken: grant.token };
}

export async function consumeResetGrantEdge(
  records: OtpRecord[],
  email: string,
  resetGrantToken: string,
  now = Date.now()
): Promise<{ valid: boolean; userId?: string; error?: string }> {
  const cleanEmail = (email || '').trim().toLowerCase();
  if (!resetGrantToken) {
    return { valid: false, error: 'Verified recovery session is required.' };
  }

  const incomingHash = await sha256Hex(resetGrantToken);
  const matching = records.find(
    (r) =>
      r.email === cleanEmail &&
      r.resetGrantTokenHash &&
      r.resetGrantExpiresAt &&
      now <= r.resetGrantExpiresAt
  );

  if (!matching || !matching.resetGrantTokenHash) {
    return { valid: false, error: 'Recovery session expired or invalid. Please request a new code.' };
  }

  const incomingBytes = hexToBytes(incomingHash);
  const storedBytes = hexToBytes(matching.resetGrantTokenHash);
  if (!incomingBytes || !storedBytes || !timingSafeEqualBytes(incomingBytes, storedBytes)) {
    return { valid: false, error: 'Recovery verification token is invalid.' };
  }

  delete matching.resetGrantTokenHash;
  delete matching.resetGrantExpiresAt;
  matching.used = true;

  return { valid: true, userId: matching.userId };
}

export async function hashPasswordPbkdf2(
  password: string,
  iterations = PBKDF2_ITERATIONS
): Promise<string> {
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: saltBytes,
      iterations,
    },
    keyMaterial,
    32 * 8
  );
  const hashHex = bytesToHex(new Uint8Array(derivedBits));
  return `pbkdf2_sha256$${iterations}$${bytesToHex(saltBytes)}$${hashHex}`;
}

async function verifyPbkdf2Hash(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$');
  if (parts.length !== 4) return false;
  const iterations = Number(parts[1]);
  const saltBytes = hexToBytes(parts[2]);
  const expectedBytes = hexToBytes(parts[3]);
  if (
    !Number.isInteger(iterations) ||
    iterations < 10_000 ||
    !saltBytes ||
    !expectedBytes ||
    expectedBytes.length === 0
  ) {
    return false;
  }

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: new Uint8Array(saltBytes),
      iterations,
    },
    keyMaterial,
    expectedBytes.length * 8
  );
  return timingSafeEqualBytes(new Uint8Array(derivedBits), expectedBytes);
}

async function verifyLegacyScryptHash(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash.includes(':')) return false;
  const [salt, expectedHex] = storedHash.split(':');
  if (!salt || !expectedHex) return false;
  const expectedBytes = hexToBytes(expectedHex);
  if (!expectedBytes) return false;

  try {
    // Supported in Node.js and Cloudflare Workers with compatibility_flags = ["nodejs_compat"]
    const nodeCrypto = await import('node:crypto');
    const derived = await new Promise<Uint8Array>((resolve, reject) => {
      nodeCrypto.scrypt(password, salt, expectedBytes.length, (err, derivedKey) => {
        if (err) reject(err);
        else resolve(new Uint8Array(derivedKey.buffer, derivedKey.byteOffset, derivedKey.byteLength));
      });
    });
    return timingSafeEqualBytes(derived, expectedBytes);
  } catch {
    return false;
  }
}

export async function verifyPasswordEdge(
  password: string,
  storedHash: string
): Promise<{ valid: boolean; needsRehash: boolean }> {
  if (!password || !storedHash || typeof storedHash !== 'string') {
    return { valid: false, needsRehash: false };
  }
  if (storedHash.startsWith('pbkdf2_sha256$')) {
    const valid = await verifyPbkdf2Hash(password, storedHash);
    return { valid, needsRehash: false };
  }
  if (storedHash.includes(':')) {
    const valid = await verifyLegacyScryptHash(password, storedHash);
    return { valid, needsRehash: valid };
  }
  return { valid: false, needsRehash: false };
}

export function base64UrlEncode(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? textEncoder.encode(input) : input;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecodeToBytes(b64u: string): Uint8Array {
  const padded = b64u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64u.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function pemPrivateKeyToDerBytes(pem: string): Uint8Array {
  const normalized = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function signRs256Jwt(
  claims: Record<string, unknown>,
  pkcs8PrivateKeyPem: string
): Promise<string> {
  const headerB64 = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payloadB64 = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${headerB64}.${payloadB64}`;

  const derBytes = pemPrivateKeyToDerBytes(pkcs8PrivateKeyPem);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    new Uint8Array(derBytes),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    textEncoder.encode(signingInput)
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}
