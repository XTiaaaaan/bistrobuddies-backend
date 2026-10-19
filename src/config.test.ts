import { describe, expect, it } from 'vitest';
import { resolveAllowedOrigins } from './config';

describe('resolveAllowedOrigins', () => {
  it('preserves configured web origins and adds the Capacitor origins', () => {
    const origins = resolveAllowedOrigins(
      'https://admin.example.com,https://mobile.example.com'
    );

    expect(origins).toContain('https://admin.example.com');
    expect(origins).toContain('https://mobile.example.com');
    expect(origins).toContain('https://localhost');
    expect(origins).toContain('capacitor://localhost');
  });

  it('adds the Capacitor origins when no allowlist is configured', () => {
    const origins = resolveAllowedOrigins(undefined);

    expect(origins).toContain('https://localhost');
    expect(origins).toContain('capacitor://localhost');
  });

  it('trims, ignores empty entries and deduplicates origins', () => {
    const origins = resolveAllowedOrigins(
      ' https://admin.example.com , ,https://localhost,https://admin.example.com '
    );

    expect(origins).toEqual([
      'https://admin.example.com',
      'https://localhost',
      'capacitor://localhost',
    ]);
  });

  it('includes no wildcard origins by default', () => {
    const origins = resolveAllowedOrigins(undefined);

    expect(origins).not.toContain('*');
  });

  it('filters the wildcard origin from a configured allowlist', () => {
    const origins = resolveAllowedOrigins('*');

    expect(origins).not.toContain('*');
    expect(origins).toEqual(['https://localhost', 'capacitor://localhost']);
  });
});
