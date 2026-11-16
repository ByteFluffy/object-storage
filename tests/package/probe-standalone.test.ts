import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkUrl } from '../../src/plugins/probe/index.js';

describe('probe package boundary', () => {
  it('exports the same URL probe with explicit public availability from its standalone entry', async () => {
    const result = await checkUrl({
      url: 'https://cdn.example/public.png', method: 'HEAD', signatureMethod: 'unsigned',
      verification: 'availability', fetch: async () => new Response(null, { status: 200 }),
    });
    expect(result.status).toBe('passed');
    expect(result.checksum).toBeUndefined();
  });

  it('does not pull probe or cleanup plugins into the root entry', () => {
    const source = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('plugins/probe');
    expect(source).not.toContain('plugins/cleanup');
  });
});
