import type { Order, OrderItem, Product } from '../types/index.ts';
import type { OtpRecord } from '../utils/authSecurity.ts';
import type {
  ContactMessageRecord,
  SessionRecord,
  StoredUserRecord,
} from './migrateDbToFirestore.ts';
import {
  ADMIN_SESSION_TTL_MS,
  CUSTOMER_SESSION_TTL_MS,
  consumeResetGrantEdge,
  generateSessionTokenEdge,
  hashPasswordPbkdf2,
  randomHex,
  sha256Hex,
  verifyOtpAttemptEdge,
  verifyPasswordEdge,
} from '../utils/edgeCrypto.ts';
import { calculateCartTotals, getEffectivePrice } from '../utils/pricing.ts';
import {
  sanitizeAndClampProductForStorage,
  sortCatalogProducts,
  type ProductWithSort,
} from '../utils/productCatalog.ts';
import {
  DELETE_FIELD_SENTINEL,
  FirestoreRestClient,
  SERVER_TIMESTAMP_SENTINEL,
} from './firestoreRest.ts';

export interface OrderLineInput {
  productId: string;
  quantity: number;
  selectedSize?: string;
  selectedColor?: string;
  name?: string;
}

export async function subscriberDocIdEdge(email: string): Promise<string> {
  const clean = email.trim().toLowerCase();
  const digest = await sha256Hex(clean);
  return 'sub_' + digest.slice(0, 24);
}

export class EdgeStoreRepository {
  constructor(private readonly client: FirestoreRestClient) {}

  get projectId(): string {
    return this.client.projectId;
  }

  get databaseId(): string {
    return this.client.databaseId;
  }

  async ensureAdminBootstrappedIfAbsent(envAdmin: {
    email?: string;
    password?: string;
    recoveryEmail?: string;
  }): Promise<void> {
    const cleanEmail = (envAdmin.email || '').trim().toLowerCase();
    const rawPassword = envAdmin.password || '';
    if (!cleanEmail || !rawPassword) return;

    const existingAdmins = await this.client.runQuery({
      collection: 'users',
      where: [{ field: 'role', op: 'EQUAL', value: 'admin' }],
      limit: 1,
    });
    if (existingAdmins.length > 0) return;

    const cleanRecovery = (envAdmin.recoveryEmail || '').trim().toLowerCase();
    const passwordHash = await hashPasswordPbkdf2(rawPassword);

    await this.client.createDocIfMissing('users', 'usr_admin', {
      id: 'usr_admin',
      email: cleanEmail,
      name: 'Maison RGD Director',
      passwordHash,
      role: 'admin',
      ...(cleanRecovery ? { recoveryEmail: cleanRecovery } : {}),
      city: 'New York',
      country: 'United States',
    });
  }

  // --- PRODUCTS ---
  async listProducts(): Promise<Product[]> {
    const docs = await this.client.listDocs('products');
    const items = docs.map((raw) =>
      sanitizeAndClampProductForStorage({ ...(raw as ProductWithSort), id: String(raw.id) })
    );
    return sortCatalogProducts(items);
  }

  async getProductById(id: string): Promise<Product | null> {
    const raw = await this.client.getDoc('products', id);
    if (!raw) return null;
    return sanitizeAndClampProductForStorage({ ...(raw as ProductWithSort), id: String(raw.id || id) });
  }

  async hasProductId(id: string): Promise<boolean> {
    const raw = await this.client.getDoc('products', id);
    return raw !== null;
  }

  async createProduct(product: ProductWithSort): Promise<ProductWithSort> {
    const safe = sanitizeAndClampProductForStorage(product, product.sortOrder ?? Date.now());
    const writes = [
      {
        update: {
          name: this.client.documentResourceName('products', safe.id),
          fields: {},
        },
      },
    ];
    void writes;

    await this.client.runTransaction(async (tx) => {
      tx.set('products', safe.id, {
        ...safe,
        createdAt: SERVER_TIMESTAMP_SENTINEL,
        updatedAt: SERVER_TIMESTAMP_SENTINEL,
      });
      tx.set(
        'catalog_meta',
        'state',
        { seeded: true, updatedAt: SERVER_TIMESTAMP_SENTINEL },
        { merge: true }
      );
    });
    return safe;
  }

  async updateProduct(id: string, product: ProductWithSort): Promise<ProductWithSort | null> {
    const existingData = await this.client.getDoc('products', id);
    if (!existingData) return null;

    const safe = sanitizeAndClampProductForStorage(
      { ...product, id },
      typeof product.sortOrder === 'number' ? product.sortOrder : (existingData as any).sortOrder
    );

    const existingCreatedAt = existingData.createdAt
      ? new Date(String(existingData.createdAt))
      : SERVER_TIMESTAMP_SENTINEL;

    await this.client.setDoc(
      'products',
      id,
      {
        ...safe,
        createdAt:
          existingCreatedAt instanceof Date && !Number.isNaN(existingCreatedAt.getTime())
            ? existingCreatedAt
            : SERVER_TIMESTAMP_SENTINEL,
        updatedAt: SERVER_TIMESTAMP_SENTINEL,
      },
      { merge: false }
    );
    return safe;
  }

  async deleteProduct(id: string): Promise<boolean> {
    const existing = await this.client.getDoc('products', id);
    if (!existing) return false;

    await this.client.runTransaction(async (tx) => {
      tx.set(
        'catalog_meta',
        'state',
        { seeded: true, updatedAt: SERVER_TIMESTAMP_SENTINEL },
        { merge: true }
      );
      tx.delete('products', id);
    });
    return true;
  }

  // --- USERS & SESSIONS ---
  async findUserByEmail(email: string): Promise<StoredUserRecord | null> {
    const clean = email.trim().toLowerCase();
    const rows = await this.client.runQuery({
      collection: 'users',
      where: [{ field: 'email', op: 'EQUAL', value: clean }],
      limit: 1,
    });
    return rows.length > 0 ? (rows[0] as StoredUserRecord) : null;
  }

  async findUserById(id: string): Promise<StoredUserRecord | null> {
    const doc = await this.client.getDoc('users', id);
    return doc ? (doc as StoredUserRecord) : null;
  }

  async findAdminByEmail(email: string): Promise<StoredUserRecord | null> {
    const user = await this.findUserByEmail(email);
    if (!user || user.role !== 'admin') return null;
    return user;
  }

  async verifyAndUpgradeUserPassword(
    user: StoredUserRecord,
    rawPassword: string
  ): Promise<boolean> {
    const check = await verifyPasswordEdge(rawPassword, user.passwordHash);
    if (!check.valid) return false;
    if (check.needsRehash) {
      try {
        const upgradedHash = await hashPasswordPbkdf2(rawPassword);
        await this.client.setDoc(
          'users',
          user.id,
          { passwordHash: upgradedHash },
          { merge: true }
        );
      } catch {
        // Non-fatal if background hash upgrade fails; verification already succeeded
      }
    }
    return true;
  }

  async createUser(user: StoredUserRecord): Promise<StoredUserRecord> {
    const clean: StoredUserRecord = {
      ...user,
      email: user.email.trim().toLowerCase(),
      recoveryEmail: user.recoveryEmail ? user.recoveryEmail.trim().toLowerCase() : undefined,
    };
    const created = await this.client.createDocIfMissing('users', clean.id, clean);
    if (!created) {
      throw new Error('User record already exists.');
    }
    return clean;
  }

  async createSession(user: StoredUserRecord): Promise<{ rawToken: string; ttlMs: number }> {
    const now = Date.now();
    const ttlMs = user.role === 'admin' ? ADMIN_SESSION_TTL_MS : CUSTOMER_SESSION_TTL_MS;
    const { token, tokenHash } = await generateSessionTokenEdge();
    const record: SessionRecord = {
      id: `sess_${randomHex(8)}`,
      userId: user.id,
      tokenHash,
      role: user.role,
      createdAt: now,
      expiresAt: now + ttlMs,
    };

    await this.client.setDoc('sessions', record.id, record);
    return { rawToken: token, ttlMs };
  }

  async getAuthContextByTokenHash(
    tokenHash: string
  ): Promise<{ user: StoredUserRecord; session: SessionRecord } | null> {
    const now = Date.now();
    const rows = await this.client.runQuery({
      collection: 'sessions',
      where: [{ field: 'tokenHash', op: 'EQUAL', value: tokenHash }],
      limit: 1,
    });
    if (rows.length === 0) return null;
    const session = rows[0] as SessionRecord;
    if (session.expiresAt <= now) {
      await this.client.deleteDoc('sessions', session.id).catch(() => {});
      return null;
    }
    const user = await this.findUserById(session.userId);
    if (!user) return null;
    return { user, session };
  }

  async deleteSessionByTokenHash(tokenHash: string): Promise<void> {
    const rows = await this.client.runQuery({
      collection: 'sessions',
      where: [{ field: 'tokenHash', op: 'EQUAL', value: tokenHash }],
    });
    if (rows.length === 0) return;

    await this.client.runTransaction(async (tx) => {
      for (const row of rows) {
        if (row.id) tx.delete('sessions', String(row.id));
      }
    });
  }

  async updateAdminProfileAndRotateSession(params: {
    user: StoredUserRecord;
    patch: Partial<StoredUserRecord>;
    envRecoveryEmail?: string;
  }): Promise<{ updatedUser: StoredUserRecord; rawToken: string; ttlMs: number }> {
    const now = Date.now();
    const ttlMs = params.user.role === 'admin' ? ADMIN_SESSION_TTL_MS : CUSTOMER_SESSION_TTL_MS;
    const { token, tokenHash } = await generateSessionTokenEdge();
    const newSession: SessionRecord = {
      id: `sess_${randomHex(8)}`,
      userId: params.user.id,
      tokenHash,
      role: params.user.role,
      createdAt: now,
      expiresAt: now + ttlMs,
    };

    const updatedUser: StoredUserRecord = {
      ...params.user,
      ...params.patch,
    };

    const oldSessions = await this.client.runQuery({
      collection: 'sessions',
      where: [{ field: 'userId', op: 'EQUAL', value: params.user.id }],
    });

    await this.client.runTransaction(async (tx) => {
      tx.set('users', params.user.id, updatedUser, { merge: true });
      for (const sess of oldSessions) {
        if (sess.id) tx.delete('sessions', String(sess.id));
      }
      tx.set('sessions', newSession.id, newSession);
      tx.set(
        'app_settings',
        'security',
        {
          adminUserId: updatedUser.id,
          hasPrivateRecoveryEmail: Boolean(updatedUser.recoveryEmail || params.envRecoveryEmail),
          updatedAt: SERVER_TIMESTAMP_SENTINEL,
        },
        { merge: true }
      );
    });

    return { updatedUser, rawToken: token, ttlMs };
  }

  async updateAdminRecoveryEmail(userId: string, cleanRecovery: string): Promise<void> {
    await this.client.runTransaction(async (tx) => {
      tx.set('users', userId, { recoveryEmail: cleanRecovery }, { merge: true });
      tx.set(
        'app_settings',
        'security',
        { hasPrivateRecoveryEmail: true, updatedAt: SERVER_TIMESTAMP_SENTINEL },
        { merge: true }
      );
    });
  }

  // --- OTP RECOVERY ---
  async replaceActiveOtpsForUser(userId: string, newRecord: OtpRecord): Promise<void> {
    const existing = await this.client.runQuery({
      collection: 'password_reset_otps',
      where: [{ field: 'userId', op: 'EQUAL', value: userId }],
    });

    await this.client.runTransaction(async (tx) => {
      for (const rec of existing) {
        if (!rec.used && rec.id) {
          tx.update('password_reset_otps', String(rec.id), { used: true });
        }
      }
      tx.set('password_reset_otps', newRecord.id, newRecord);
    });
  }

  async markOtpUsed(otpId: string): Promise<void> {
    await this.client.setDoc('password_reset_otps', otpId, { used: true }, { merge: true });
  }

  async verifyOtp(
    email: string,
    otpInput: string
  ): Promise<{ success: boolean; error?: string; resetGrantToken?: string }> {
    const cleanEmail = email.trim().toLowerCase();
    const now = Date.now();

    return await this.client.runTransaction(async (tx) => {
      const docs = await tx.query('password_reset_otps', [
        { field: 'email', op: 'EQUAL', value: cleanEmail },
      ]);
      const records = docs
        .map((d) => ({ ...(d as OtpRecord) }))
        .sort((a, b) => a.createdAt - b.createdAt);

      const result = await verifyOtpAttemptEdge(records, cleanEmail, otpInput, now);
      for (const rec of records) {
        tx.set('password_reset_otps', rec.id, rec, { merge: true });
      }
      return result;
    });
  }

  async consumeResetGrantAndUpdateAdminPassword(params: {
    email: string;
    resetGrantToken: string;
    newPasswordHash: string;
  }): Promise<{ valid: boolean; error?: string }> {
    const cleanEmail = params.email.trim().toLowerCase();
    const now = Date.now();

    return await this.client.runTransaction(async (tx) => {
      const docs = await tx.query('password_reset_otps', [
        { field: 'email', op: 'EQUAL', value: cleanEmail },
      ]);
      const records = docs.map((d) => ({ ...(d as OtpRecord) }));
      const grant = await consumeResetGrantEdge(records, cleanEmail, params.resetGrantToken, now);

      if (!grant.valid || !grant.userId) {
        for (const rec of records) {
          tx.update('password_reset_otps', rec.id, { used: rec.used });
        }
        return { valid: false, error: grant.error };
      }

      const userData = (await tx.get('users', grant.userId)) as StoredUserRecord | null;
      if (!userData || userData.role !== 'admin') {
        return { valid: false, error: 'Account could not be updated.' };
      }

      const sessions = await tx.query('sessions', [
        { field: 'userId', op: 'EQUAL', value: grant.userId },
      ]);

      tx.update('users', grant.userId, { passwordHash: params.newPasswordHash });
      for (const sess of sessions) {
        if (sess.id) tx.delete('sessions', String(sess.id));
      }
      for (const rec of records) {
        tx.update('password_reset_otps', rec.id, {
          used: true,
          resetGrantTokenHash: DELETE_FIELD_SENTINEL,
          resetGrantExpiresAt: DELETE_FIELD_SENTINEL,
        });
      }

      return { valid: true };
    });
  }

  // --- ORDERS (WITH ATOMIC FIRESTORE REST TRANSACTIONS) ---
  private sortOrdersNewestFirst(list: Order[]): Order[] {
    return [...list].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async listAllOrders(): Promise<Order[]> {
    const docs = await this.client.listDocs('orders');
    return this.sortOrdersNewestFirst(docs as Order[]);
  }

  async listOrdersForCustomer(userId: string): Promise<Order[]> {
    const cleanUserId = (userId || '').trim();
    if (!cleanUserId) return [];

    const docs = await this.client.runQuery({
      collection: 'orders',
      where: [{ field: 'userId', op: 'EQUAL', value: cleanUserId }],
    });
    return this.sortOrdersNewestFirst(docs as Order[]);
  }

  async createOrderTransaction(params: {
    items: OrderLineInput[];
    customer: Order['customer'];
    userId?: string;
    paymentMethod: 'cod' | 'card_demo';
    promoCode?: string;
    notes?: string;
  }): Promise<{ order?: Order; error?: string; statusCode?: number }> {
    const orderNum =
      'RGD-' + new Date().getFullYear() + '-' + Math.floor(10000 + Math.random() * 90000);
    const trackNum = 'RGD-EXP-' + Math.floor(10000000 + Math.random() * 90000000);
    const orderId = `ord_${Date.now()}_${randomHex(2)}`;

    return await this.client.runTransaction(async (tx) => {
      const distinctIds = Array.from(new Set(params.items.map((it) => String(it.productId))));
      const rawMap = await tx.batchGet(
        distinctIds.map((id) => ({ collection: 'products', id }))
      );

      const productMap = new Map<string, Product>();
      for (const id of distinctIds) {
        const raw = rawMap.get(id);
        if (raw) {
          productMap.set(
            id,
            sanitizeAndClampProductForStorage({ ...(raw as ProductWithSort), id })
          );
        }
      }

      const requestedByProduct = new Map<string, number>();
      const resolvedCartItems: Array<{
        product: Product;
        quantity: number;
        selectedSize?: string;
        selectedColor?: string;
      }> = [];

      for (const item of params.items) {
        const qty = Number(item.quantity);
        if (!Number.isInteger(qty) || qty <= 0) {
          return { error: 'Invalid item quantity.', statusCode: 400 };
        }
        const prod = productMap.get(String(item.productId));
        if (!prod) {
          return {
            error: `Product "${item.name || item.productId}" no longer exists.`,
            statusCode: 400,
          };
        }
        const nextTotalQty = (requestedByProduct.get(prod.id) || 0) + qty;
        if (prod.stockCount < nextTotalQty) {
          return {
            error: `Insufficient inventory for "${prod.name}". Only ${prod.stockCount} available.`,
            statusCode: 400,
          };
        }
        requestedByProduct.set(prod.id, nextTotalQty);
        resolvedCartItems.push({
          product: prod,
          quantity: qty,
          selectedSize: typeof item.selectedSize === 'string' ? item.selectedSize : undefined,
          selectedColor: typeof item.selectedColor === 'string' ? item.selectedColor : undefined,
        });
      }

      const totals = calculateCartTotals(resolvedCartItems, params.promoCode);
      const authoritativeItems: OrderItem[] = resolvedCartItems.map((resolved) => ({
        productId: resolved.product.id,
        name: resolved.product.name,
        price: getEffectivePrice(resolved.product),
        originalPrice: resolved.product.originalPrice,
        quantity: resolved.quantity,
        selectedSize: resolved.selectedSize,
        selectedColor: resolved.selectedColor,
        image: resolved.product.image,
      }));

      for (const [prodId, qtySum] of requestedByProduct.entries()) {
        const prod = productMap.get(prodId)!;
        const nextStock = Math.max(0, prod.stockCount - qtySum);
        tx.update('products', prodId, {
          stockCount: nextStock,
          inStock: nextStock > 0,
          updatedAt: SERVER_TIMESTAMP_SENTINEL,
        });
      }

      const newOrder: Order = {
        id: orderId,
        orderNumber: orderNum,
        createdAt: new Date().toISOString(),
        userId: params.userId,
        customer: params.customer,
        items: authoritativeItems,
        subtotal: totals.subtotal,
        shippingFee: totals.shippingFee,
        tax: totals.tax,
        discount: totals.discount,
        total: totals.total,
        paymentMethod: params.paymentMethod,
        paymentStatus: params.paymentMethod === 'cod' ? 'pending' : 'demo_unpaid',
        orderStatus: 'Confirmed',
        trackingNumber: trackNum,
        notes: params.notes || '',
      };

      tx.set('orders', newOrder.id, newOrder);
      return { order: newOrder };
    });
  }

  async updateOrderStatus(
    orderId: string,
    patch: { status?: Order['orderStatus']; trackingNumber?: string }
  ): Promise<Order | null> {
    const existing = await this.client.getDoc('orders', orderId);
    if (!existing) return null;
    const updates: Partial<Order> = {};
    if (patch.status) updates.orderStatus = patch.status;
    if (patch.trackingNumber) updates.trackingNumber = patch.trackingNumber;
    if (Object.keys(updates).length > 0) {
      await this.client.setDoc('orders', orderId, updates, { merge: true });
    }
    return { ...(existing as Order), ...updates };
  }

  // --- NEWSLETTER, CONTACT & ADMIN CLAIMS ---
  async addSubscriber(email: string): Promise<void> {
    const clean = email.trim().toLowerCase();
    const id = await subscriberDocIdEdge(clean);
    await this.client.setDoc(
      'subscribers',
      id,
      {
        id,
        email: clean,
        createdAt: new Date().toISOString(),
      },
      { merge: true }
    );
  }

  async addContactMessage(msg: ContactMessageRecord): Promise<void> {
    await this.client.setDoc('contact_messages', msg.id, msg);
  }

  async grantAdminCloudAccess(uid: string, email: string): Promise<{ customClaimSet: boolean }> {
    await this.client.setDoc(
      'admins',
      uid,
      {
        email: email.trim().toLowerCase(),
        createdAt: SERVER_TIMESTAMP_SENTINEL,
      },
      { merge: true }
    );
    const customClaimSet = await this.client.setCustomAdminClaimBestEffort(uid);
    return { customClaimSet };
  }
}
