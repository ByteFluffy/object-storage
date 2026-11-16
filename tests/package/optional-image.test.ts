import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('optional image entry', () => {
  it('owns its image engine without requiring consumers to install it', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(manifest.dependencies?.sharp).toBe('0.34.5');
    expect(manifest.peerDependencies?.sharp).toBeUndefined();
  });

  it('does not reference the image plugin or sharp from the package root', () => {
    const source = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('plugins/image');
    expect(source).not.toContain('sharp');
  });
});
