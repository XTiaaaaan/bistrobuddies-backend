import * as fs from 'node:fs';
import * as os from 'node:os';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const state = vi.hoisted(() => ({
  userRole: 'customer' as string | null,
}));

vi.mock('./firebase/admin', () => {
  async function verifyIdToken(token: string): Promise<{ uid: string }> {
    if (token === 'valid-customer') {
      return { uid: 'cust-1' };
    }
    if (token === 'valid-admin') {
      return { uid: 'admin-1' };
    }
    throw new Error('invalid token');
  }

  return {
    firebaseReady: () => true,
    requireFirebase: () => ({
      auth: { verifyIdToken },
      db: {
        doc: (docPath: string) => ({
          get: async () => {
            if (docPath.startsWith('users/')) {
              const role = state.userRole;
              return {
                exists: role !== null,
                data: () => (role !== null ? { role } : undefined),
              };
            }
            return { exists: false, data: () => undefined };
          },
        }),
      },
    }),
    resetFirebaseForTests: () => undefined,
  };
});

// Overrides must be in place before the app (and its config) is imported.
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-profile-uploads-'));
process.env['UPLOAD_DIR'] = UPLOAD_DIR;
process.env['UPLOAD_MAX_BYTES'] = '1024';
process.env['API_BASE_URL'] = 'http://localhost:3001';

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Minimal byte blobs that pass the server's magic-byte sniffing. */
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

/** Builds a multipart/form-data body without relying on DOM types. */
function multipart(options: UploadOptions): {
  body: Buffer;
  contentType: string;
} {
  const boundary = `----bistrobuddies${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${options.fieldName ?? 'file'}"; ` +
      `filename="${options.fileName ?? 'selfie.png'}"\r\n` +
      `Content-Type: ${options.mimeType ?? 'application/octet-stream'}\r\n\r\n`,
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    body: Buffer.concat([head, options.bytes, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe('POST /api/profile/photo (customer profile pictures)', () => {
  let server: Server;
  let base: string;
  let createApp: typeof import('./app').createApp;

  beforeAll(async () => {
    ({ createApp } = await import('./app'));
  });

  beforeEach(async () => {
    state.userRole = 'customer';
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

  afterAll(() => {
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  });

  function upload(options: UploadOptions): Promise<Response> {
    const { body, contentType } = multipart(options);
    return fetch(`${base}/api/profile/photo`, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body,
    });
  }

  function filesInUploadDir(): string[] {
    return fs.readdirSync(UPLOAD_DIR);
  }

  it('rejects requests without a Bearer token (401)', async () => {
    const before = filesInUploadDir().length;
    const response = await upload({ bytes: imageBytes('image/png') });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
    expect(filesInUploadDir()).toHaveLength(before);
  });

  it('rejects invalid tokens (401)', async () => {
    const response = await upload({
      token: 'forged-token',
      bytes: imageBytes('image/png'),
    });
    expect(response.status).toBe(401);
  });

  it('accepts a signed-in customer without any admin role (201)', async () => {
    state.userRole = 'customer';
    const before = filesInUploadDir().length;
    const response = await upload({
      token: 'valid-customer',
      bytes: imageBytes('image/png'),
    });
    expect(response.status).toBe(201);
    expect(filesInUploadDir()).toHaveLength(before + 1);
  });

  it('accepts an admin user too (201)', async () => {
    state.userRole = 'admin';
    const response = await upload({
      token: 'valid-admin',
      bytes: imageBytes('image/jpeg'),
    });
    expect(response.status).toBe(201);
  });

  it('accepts JPEG, PNG and WebP images (201)', async () => {
    for (const mimeType of ['image/jpeg', 'image/png', 'image/webp']) {
      const bytes = imageBytes(mimeType);
      const response = await upload({ token: 'valid-customer', bytes });
      expect(response.status).toBe(201);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body['mimeType']).toBe(mimeType);
      expect(body['size']).toBe(bytes.length);
      expect(body['path']).toBe(`/uploads/${body['fileName']}`);
    }
  });

  it('rejects non-image content (415)', async () => {
    const before = filesInUploadDir().length;
    const response = await upload({
      token: 'valid-customer',
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      bytes: Buffer.from('this is definitely not an image'),
    });
    expect(response.status).toBe(415);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unsupported_media_type');
    expect(filesInUploadDir()).toHaveLength(before);
  });

  it('rejects files above the configured size limit (413)', async () => {
    const before = filesInUploadDir().length;
    // UPLOAD_MAX_BYTES is 1024 in this suite; 2000 bytes must fail.
    const response = await upload({
      token: 'valid-customer',
      bytes: imageBytes('image/png', 2000),
    });
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('file_too_large');
    expect(filesInUploadDir()).toHaveLength(before);
  });

  it('rejects a request without a file field (400)', async () => {
    const response = await upload({
      token: 'valid-customer',
      fieldName: 'attachment',
      bytes: imageBytes('image/png'),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });

  it('returns an absolute imageUrl built from API_BASE_URL', async () => {
    const response = await upload({
      token: 'valid-customer',
      bytes: imageBytes('image/png'),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['imageUrl']).toBe(
      `http://localhost:3001/uploads/${body['fileName']}`
    );
    expect(typeof body['uploadedAt']).toBe('string');
  });

  it('generates a safe unique name and ignores the client file name', async () => {
    const before = filesInUploadDir();
    const response = await upload({
      token: 'valid-customer',
      fileName: '../../evil.png',
      bytes: imageBytes('image/png'),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    const fileName = body['fileName'] as string;

    expect(fileName).not.toContain('..');
    expect(fileName).not.toContain('/');
    expect(fileName).not.toContain('\\');
    expect(path.extname(fileName)).toBe('.png');
    expect(path.basename(fileName)).toBe(fileName);
    expect(path.resolve(UPLOAD_DIR, fileName).startsWith(UPLOAD_DIR)).toBe(true);
    const written = filesInUploadDir().filter((name) => !before.includes(name));
    expect(written).toEqual([fileName]);
  });

  it('serves the stored photo at GET /uploads/<file> with a cross-origin CORP header', async () => {
    const bytes = imageBytes('image/jpeg', 256);
    const uploaded = (await (
      await upload({ token: 'valid-customer', bytes })
    ).json()) as Record<string, unknown>;

    const response = await fetch(
      `${base}/uploads/${uploaded['fileName'] as string}`
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/jpeg');
    expect(
      response.headers.get('cross-origin-resource-policy')
    ).toBe('cross-origin');
    const served = Buffer.from(await response.arrayBuffer());
    expect(served.equals(bytes)).toBe(true);
  });
});
