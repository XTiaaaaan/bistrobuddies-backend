import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => ({ __serverTimestamp: true }),
  },
}));

const state = vi.hoisted(() => {
  const FIXED_NOW = new Date('2026-10-20T00:00:00.000Z');

  function toStored(value: unknown): unknown {
    if (value !== null && typeof value === 'object') {
      if ((value as Record<string, unknown>)['__serverTimestamp'] === true) {
        return new Date(FIXED_NOW);
      }
      if (Array.isArray(value)) {
        return value.map(toStored);
      }
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(
        value as Record<string, unknown>
      )) {
        out[key] = toStored(entry);
      }
      return out;
    }
    return value;
  }

  const store = {
    roles: new Map<string, string>(),
    orders: new Map<string, Record<string, unknown>>(),
    writes: 0,
    failOrderUpdate: false,
  };

  function docRef(path: string) {
    return {
      __path: path,
      get: async () => {
        if (path.startsWith('users/')) {
          const role = store.roles.get(path.slice('users/'.length));
          return {
            exists: role !== undefined,
            data: () => (role !== undefined ? { role } : undefined),
          };
        }
        if (path.startsWith('orders/')) {
          const data = store.orders.get(path.slice('orders/'.length));
          return {
            exists: data !== undefined,
            data: () => data,
          };
        }
        return { exists: false, data: () => undefined };
      },
      set: async (payload: Record<string, unknown>) => {
        if (path.startsWith('orders/')) {
          store.orders.set(
            path.slice('orders/'.length),
            toStored(payload) as Record<string, unknown>
          );
          store.writes += 1;
        }
      },
      update: async (patch: Record<string, unknown>) => {
        if (path.startsWith('orders/')) {
          if (store.failOrderUpdate) {
            throw new Error('simulated Firestore write failure');
          }
          const id = path.slice('orders/'.length);
          const current = store.orders.get(id) ?? {};
          store.orders.set(id, {
            ...current,
            ...(toStored(patch) as Record<string, unknown>),
          });
          store.writes += 1;
        }
      },
      delete: async () => undefined,
    };
  }

  function buildDb() {
    return {
      doc: (path: string) => docRef(path),
      collection: (name: string) => ({
        doc: (id?: string) => {
          const ref = docRef(`${name}/${id ?? 'generated-1'}`);
          return { id: id ?? 'generated-1', set: ref.set, get: ref.get };
        },
      }),
      runTransaction: async (
        fn: (tx: {
          get: (ref: unknown) => Promise<unknown>;
          update: (ref: unknown, patch: Record<string, unknown>) => void;
          set: (ref: unknown, payload: Record<string, unknown>) => void;
        }) => Promise<unknown>
      ) => {
        const tx = {
          get: (ref: unknown) =>
            (ref as ReturnType<typeof docRef>).get() as Promise<unknown>,
          update: (ref: unknown, patch: Record<string, unknown>) => {
            if (store.failOrderUpdate) {
              throw new Error('simulated Firestore write failure');
            }
            return (ref as ReturnType<typeof docRef>).update(patch);
          },
          set: (ref: unknown, payload: Record<string, unknown>) =>
            (ref as ReturnType<typeof docRef>).set(payload),
        };
        return fn(tx);
      },
    };
  }

  async function verifyIdToken(
    token: string
  ): Promise<{ uid: string; email?: string }> {
    if (token === 'valid-admin') {
      return { uid: 'admin-1', email: 'admin@example.com' };
    }
    if (token === 'valid-customer') {
      return { uid: 'cust-1', email: 'customer@example.com' };
    }
    if (token === 'valid-customer-2') {
      return { uid: 'cust-2', email: 'customer2@example.com' };
    }
    throw new Error('invalid token');
  }

  return { store, buildDb, verifyIdToken, FIXED_NOW };
});

vi.mock('./firebase/admin', () => ({
  firebaseReady: () => true,
  requireFirebase: () => ({
    auth: { verifyIdToken: state.verifyIdToken },
    db: state.buildDb(),
  }),
  resetFirebaseForTests: () => undefined,
}));

vi.mock('cloudinary', () => ({
  v2: {
    config: vi.fn(),
    uploader: { upload: vi.fn(), destroy: vi.fn() },
  },
}));

process.env['CLOUDINARY_CLOUD_NAME'] = 'test-cloud';
process.env['CLOUDINARY_API_KEY'] = 'test-key';
process.env['CLOUDINARY_API_SECRET'] = 'test-secret';
// Lower than the 5 MB production default so the size test stays lightweight;
// the limit itself is `config.uploadMaxBytes` (default 5242880).
process.env['UPLOAD_MAX_BYTES'] = '1024';

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function imageBytes(mimeType: string, size = 128): Buffer {
  const buffer = Buffer.alloc(size);
  if (mimeType === 'image/png') {
    PNG_SIGNATURE.copy(buffer);
  } else if (mimeType === 'image/jpeg') {
    buffer[0] = 0xff;
    buffer[1] = 0xd8;
    buffer[2] = 0xff;
  } else {
    buffer.write('RIFF', 0, 'latin1');
    buffer.write('WEBP', 8, 'latin1');
  }
  return buffer;
}

interface UploadOptions {
  token?: string | null;
  fileName?: string;
  fieldName?: string;
  mimeType?: string;
  bytes: Buffer;
}

function multipart(options: UploadOptions): {
  body: Buffer;
  contentType: string;
} {
  const boundary = `----bistrobuddies${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${options.fieldName ?? 'file'}"; ` +
      `filename="${options.fileName ?? 'proof.png'}"\r\n` +
      `Content-Type: ${options.mimeType ?? 'application/octet-stream'}\r\n\r\n`,
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    body: Buffer.concat([head, options.bytes, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

const PROOF = {
  url: 'https://res.cloudinary.com/test-cloud/image/upload/v1/bistrobuddies/old-proof.png',
  publicId: 'bistrobuddies/old-proof',
  mimeType: 'image/png',
  size: 128,
  submittedBy: 'cust-1',
  submittedAt: '2026-10-16T00:00:00.000Z',
};

const GCASH_DETAILS = {
  accountName: 'Juan dela Cruz',
  accountNumber: '09171234567',
  submittedBy: 'cust-1',
  submittedAt: '2026-10-16T00:00:00.000Z',
};

function order(
  id: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    customerId: 'cust-1',
    customerSnapshot: { uid: 'cust-1', name: 'Juan', email: '', phone: '' },
    addressSnapshot: {},
    items: [],
    subtotal: 200,
    deliveryFee: 0,
    total: 200,
    currency: 'PHP',
    customerComment: '',
    paymentMethod: 'GCASH',
    paymentStatus: 'PENDING',
    orderStatus: 'PENDING',
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
    ...overrides,
  };
}

describe('GCash payment proof and payment status correction', () => {
  let server: Server;
  let base: string;
  let createApp: typeof import('./app').createApp;
  let uploadMock: Mock;
  let destroyMock: Mock;

  beforeAll(async () => {
    // Import after the environment overrides above so config picks them up.
    ({ createApp } = await import('./app'));
  });

  beforeEach(async () => {
    state.store.roles = new Map([
      ['admin-1', 'admin'],
      ['cust-1', 'customer'],
      ['cust-2', 'customer'],
    ]);
    state.store.orders = new Map<string, Record<string, unknown>>([
      ['g-pending', order('g-pending')],
      [
        'g-ready',
        order('g-ready', {
          paymentStatus: 'VERIFYING',
          gcashDetails: GCASH_DETAILS,
        }),
      ],
      [
        'g-with-proof',
        order('g-with-proof', {
          paymentStatus: 'VERIFYING',
          gcashDetails: GCASH_DETAILS,
          paymentProof: PROOF,
        }),
      ],
      [
        'g-rejected',
        order('g-rejected', {
          paymentStatus: 'REJECTED',
          gcashDetails: GCASH_DETAILS,
          paymentProof: PROOF,
        }),
      ],
      [
        'g-paid',
        order('g-paid', {
          paymentStatus: 'PAID',
          gcashDetails: GCASH_DETAILS,
          paymentProof: PROOF,
          paymentDecision: {
            decision: 'PAID',
            decidedBy: 'admin-1',
            decidedAt: '2026-10-16T00:00:00.000Z',
          },
        }),
      ],
      [
        'g-completed',
        order('g-completed', {
          orderStatus: 'COMPLETED',
          paymentStatus: 'VERIFYING',
          gcashDetails: GCASH_DETAILS,
        }),
      ],
      [
        'g-other',
        order('g-other', { customerId: 'cust-2' }),
      ],
      [
        'cod-pending',
        order('cod-pending', { paymentMethod: 'COD' }),
      ],
      [
        'cod-completed',
        order('cod-completed', {
          paymentMethod: 'COD',
          orderStatus: 'COMPLETED',
          paymentStatus: 'PENDING',
        }),
      ],
      [
        'cod-paid',
        order('cod-paid', {
          paymentMethod: 'COD',
          paymentStatus: 'PAID',
        }),
      ],
    ]);
    state.store.writes = 0;
    state.store.failOrderUpdate = false;

    const { v2: cloudinary } = await import('cloudinary');
    uploadMock = cloudinary.uploader.upload as unknown as Mock;
    destroyMock = cloudinary.uploader.destroy as unknown as Mock;
    uploadMock.mockReset();
    destroyMock.mockReset();
    let uploads = 0;
    uploadMock.mockImplementation(async (dataUri: string) => {
      uploads += 1;
      const mime = dataUri.slice(5, dataUri.indexOf(';'));
      return {
        secure_url: `https://res.cloudinary.com/test-cloud/image/upload/v1/bistrobuddies/proof-${uploads}-${mime.replace('/', '-')}.png`,
        public_id: `bistrobuddies/proof-${uploads}`,
      };
    });
    destroyMock.mockResolvedValue({ result: 'ok' });

    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  function uploadProof(
    orderId: string,
    options: UploadOptions
  ): Promise<Response> {
    const { body, contentType } = multipart(options);
    return fetch(`${base}/api/orders/${orderId}/payment-proof`, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body,
    });
  }

  function decide(orderId: string, token: string | null, body: unknown) {
    return fetch(`${base}/api/admin/orders/${orderId}/payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  function confirmCod(orderId: string, token: string | null) {
    return fetch(`${base}/api/admin/orders/${orderId}/cod-payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ decision: 'PAID' }),
    });
  }

  function status(orderId: string, orderStatus: string) {
    return fetch(`${base}/api/admin/orders/${orderId}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-admin',
      },
      body: JSON.stringify({ orderStatus }),
    });
  }

  function stored(id: string): Record<string, unknown> {
    return state.store.orders.get(id) as Record<string, unknown>;
  }

  describe('POST /api/orders/:id/payment-proof', () => {
    it('requires authentication', async () => {
      const response = await uploadProof('g-pending', {
        token: null,
        bytes: imageBytes('image/png'),
      });
      expect(response.status).toBe(401);
      expect(uploadMock).not.toHaveBeenCalled();
    });

    it('hides another customer order behind 404 before uploading', async () => {
      const response = await uploadProof('g-other', {
        token: 'valid-customer',
        bytes: imageBytes('image/png'),
      });
      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'order_not_found'
      );
      expect(uploadMock).not.toHaveBeenCalled();
    });

    it('rejects COD orders', async () => {
      const response = await uploadProof('cod-pending', {
        token: 'valid-customer',
        bytes: imageBytes('image/png'),
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'invalid_payment_method'
      );
      expect(uploadMock).not.toHaveBeenCalled();
    });

    it('rejects a missing file', async () => {
      const response = await uploadProof('g-pending', {
        token: 'valid-customer',
        fieldName: 'attachment',
        bytes: imageBytes('image/png'),
      });
      expect(response.status).toBe(400);
      expect(uploadMock).not.toHaveBeenCalled();
    });

    it('rejects a file whose content is not a supported image', async () => {
      const response = await uploadProof('g-pending', {
        token: 'valid-customer',
        fileName: 'fake.png',
        mimeType: 'image/png',
        bytes: Buffer.from('this is not an image'),
      });
      expect(response.status).toBe(415);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'unsupported_media_type'
      );
      expect(uploadMock).not.toHaveBeenCalled();
    });

    it('rejects images above the configured upload limit', async () => {
      const response = await uploadProof('g-pending', {
        token: 'valid-customer',
        bytes: imageBytes('image/png', 2000),
      });
      expect(response.status).toBe(413);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'file_too_large'
      );
      expect(uploadMock).not.toHaveBeenCalled();
    });

    it('stores JPEG, PNG and WebP proof and moves PENDING to VERIFYING', async () => {
      for (const mimeType of ['image/jpeg', 'image/png', 'image/webp']) {
        const response = await uploadProof('g-pending', {
          token: 'valid-customer',
          bytes: imageBytes(mimeType),
        });
        expect(response.status).toBe(201);
        const body = (await response.json()) as Record<string, unknown>;
        expect(body['paymentStatus']).toBe('VERIFYING');
        expect(body['paymentProof']).toMatchObject({
          mimeType,
          submittedBy: 'cust-1',
        });
        expect((body['paymentProof'] as Record<string, unknown>)['url']).toMatch(
          /^https:\/\//
        );

        const doc = stored('g-pending');
        expect(doc['paymentStatus']).toBe('VERIFYING');
        expect(doc['paymentProofUrl']).toMatch(/^https:\/\//);
        expect(doc['paymentProof']).toMatchObject({ mimeType });
        expect(doc['gcashProof']).toEqual(doc['paymentProof']);
        expect((doc['paymentProof'] as Record<string, unknown>)['submittedAt']).toBeInstanceOf(
          Date
        );
        // No image bytes/base64 are stored in Firestore.
        expect(JSON.stringify(doc)).not.toContain('base64');
      }
      expect(uploadMock).toHaveBeenCalledTimes(3);
    });

    it('allows replacement proof while VERIFYING and after REJECTED', async () => {
      const verifying = await uploadProof('g-with-proof', {
        token: 'valid-customer',
        bytes: imageBytes('image/png'),
      });
      expect(verifying.status).toBe(201);
      expect(stored('g-with-proof')['paymentStatus']).toBe('VERIFYING');

      const rejected = await uploadProof('g-rejected', {
        token: 'valid-customer',
        bytes: imageBytes('image/webp'),
      });
      expect(rejected.status).toBe(201);
      expect(stored('g-rejected')['paymentStatus']).toBe('VERIFYING');
      expect((stored('g-rejected')['paymentProof'] as Record<string, unknown>)['mimeType']).toBe(
        'image/webp'
      );
    });

    it('refuses to change proof after the payment is PAID', async () => {
      const response = await uploadProof('g-paid', {
        token: 'valid-customer',
        bytes: imageBytes('image/png'),
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'payment_already_confirmed'
      );
      expect(uploadMock).not.toHaveBeenCalled();
    });

    it('deletes the newly uploaded asset when saving the order fails', async () => {
      state.store.failOrderUpdate = true;
      const response = await uploadProof('g-pending', {
        token: 'valid-customer',
        bytes: imageBytes('image/png'),
      });
      expect(response.status).toBe(500);
      expect(uploadMock).toHaveBeenCalledTimes(1);
      expect(destroyMock).toHaveBeenCalledTimes(1);
      const uploadedPublicId = (destroyMock.mock.calls[0]?.[0] ?? '') as string;
      expect(uploadedPublicId).toMatch(/^bistrobuddies\/proof-/);
      expect(stored('g-pending')['paymentStatus']).toBe('PENDING');
    });
  });

  describe('admin proof approval/rejection', () => {
    it('requires authentication and the admin role', async () => {
      const anonymous = await decide('g-with-proof', null, { decision: 'PAID' });
      expect(anonymous.status).toBe(401);

      const customer = await decide('g-with-proof', 'valid-customer', {
        decision: 'PAID',
      });
      expect(customer.status).toBe(403);
    });

    it('requires proof before a GCash payment can become PAID', async () => {
      const response = await decide('g-ready', 'valid-admin', {
        decision: 'PAID',
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'payment_proof_required'
      );
      expect(stored('g-ready')['paymentStatus']).toBe('VERIFYING');
    });

    it('lets an admin approve submitted proof without touching order status', async () => {
      const response = await decide('g-with-proof', 'valid-admin', {
        decision: 'PAID',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        id: 'g-with-proof',
        paymentStatus: 'PAID',
      });

      const doc = stored('g-with-proof');
      expect(doc['paymentStatus']).toBe('PAID');
      expect(doc['orderStatus']).toBe('PENDING');
      expect((doc['paymentDecision'] as Record<string, unknown>)['decision']).toBe(
        'PAID'
      );
      const audit = doc['paymentAudit'] as Array<Record<string, unknown>>;
      expect(audit[audit.length - 1]).toMatchObject({
        from: 'VERIFYING',
        to: 'PAID',
        actorUid: 'admin-1',
        actorRole: 'admin',
      });
    });

    it('lets an admin reject proof and the customer replace it', async () => {
      const rejected = await decide('g-with-proof', 'valid-admin', {
        decision: 'REJECTED',
      });
      expect(rejected.status).toBe(200);
      expect(stored('g-with-proof')['paymentStatus']).toBe('REJECTED');

      const replaced = await uploadProof('g-with-proof', {
        token: 'valid-customer',
        bytes: imageBytes('image/png'),
      });
      expect(replaced.status).toBe(201);
      expect(stored('g-with-proof')['paymentStatus']).toBe('VERIFYING');

      const approved = await decide('g-with-proof', 'valid-admin', {
        decision: 'PAID',
      });
      expect(approved.status).toBe(200);
      expect(stored('g-with-proof')['paymentStatus']).toBe('PAID');
    });

    it('never overwrites an already PAID payment', async () => {
      const response = await decide('g-paid', 'valid-admin', {
        decision: 'REJECTED',
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'invalid_payment_transition'
      );
      expect(stored('g-paid')['paymentStatus']).toBe('PAID');
    });

    it('includes the proof URL in admin order data', async () => {
      const response = await fetch(`${base}/api/orders/g-with-proof`, {
        headers: { Authorization: 'Bearer valid-admin' },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body['paymentProofUrl']).toBe(PROOF.url);
      expect(body['paymentProof']).toMatchObject({ url: PROOF.url });
      expect(body['gcashProof']).toMatchObject({ url: PROOF.url });
    });
  });

  describe('COD and independent payment status', () => {
    it('does not mark COD PAID merely because the order is COMPLETED', async () => {
      const response = await status('cod-pending', 'CONFIRMED');
      expect(response.status).toBe(200);
      await status('cod-pending', 'PREPARING');
      await status('cod-pending', 'READY');
      const completed = await status('cod-pending', 'COMPLETED');
      expect(completed.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(stored('cod-pending')['orderStatus']).toBe('COMPLETED');
      expect(stored('cod-pending')['paymentStatus']).toBe('PENDING');
    });

    it('lets an admin explicitly confirm COD collection', async () => {
      const response = await confirmCod('cod-completed', 'valid-admin');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        id: 'cod-completed',
        paymentStatus: 'PAID',
      });
      const doc = stored('cod-completed');
      expect(doc['paymentStatus']).toBe('PAID');
      expect(doc['orderStatus']).toBe('COMPLETED');
      const audit = doc['paymentAudit'] as Array<Record<string, unknown>>;
      expect(audit[audit.length - 1]).toMatchObject({
        from: 'PENDING',
        to: 'PAID',
        actorUid: 'admin-1',
        actorRole: 'admin',
      });
    });

    it('makes repeated COD confirmation idempotent', async () => {
      await confirmCod('cod-completed', 'valid-admin');
      const writes = state.store.writes;
      const response = await confirmCod('cod-completed', 'valid-admin');
      expect(response.status).toBe(200);
      expect(state.store.writes).toBe(writes);
      expect(stored('cod-completed')['paymentStatus']).toBe('PAID');
    });

    it('requires admin authorization for COD confirmation', async () => {
      const anon = await confirmCod('cod-completed', null);
      expect(anon.status).toBe(401);
      const customer = await confirmCod('cod-completed', 'valid-customer');
      expect(customer.status).toBe(403);
      const gcash = await confirmCod('g-with-proof', 'valid-admin');
      expect(gcash.status).toBe(409);
      expect(stored('cod-completed')['paymentStatus']).toBe('PENDING');
    });

    it('keeps a completed GCash order VERIFYING until an admin decides', async () => {
      expect(stored('g-completed')['paymentStatus']).toBe('VERIFYING');
      const response = await decide('g-completed', 'valid-admin', {
        decision: 'PAID',
      });
      expect(response.status).toBe(409);
      expect(stored('g-completed')['paymentStatus']).toBe('VERIFYING');
    });
  });
});
