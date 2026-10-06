import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/auth', () => ({ appOrigin: () => 'https://workforce.example' }));
import { requireSameOrigin } from '../src/lib/imports/http';

describe('import write origin', () => {
  it('requires an Origin matching the configured HTTPS app origin', () => {
    const request = (origin?: string) => new Request('https://internal-proxy.example/api/imports/commit', {
      method: 'POST', headers: origin ? { Origin: origin } : {},
    });
    expect(() => requireSameOrigin(request())).toThrow(/invalid origin/i);
    expect(() => requireSameOrigin(request('https://attacker.example'))).toThrow(/invalid origin/i);
    expect(() => requireSameOrigin(request('https://workforce.example'))).not.toThrow();
  });
});
