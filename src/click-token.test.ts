import { describe, expect, it } from 'vitest';
import { parseClickToken, signClickToken } from './click-token';

describe('click-token', () => {
    const secret = 'unit-test-secret';

    it('round-trips a log id', () => {
        const t = signClickToken(secret, 4321);
        expect(t).toMatch(/^4321\.[0-9a-f]{32}$/);
        expect(parseClickToken(secret, t)).toBe(4321);
    });

    it('rejects a token signed with another secret', () => {
        expect(parseClickToken('other', signClickToken(secret, 7))).toBeNull();
    });

    it('rejects a tampered id', () => {
        const [, sig] = signClickToken(secret, 7).split('.');
        expect(parseClickToken(secret, `8.${sig}`)).toBeNull();
    });

    it('rejects malformed input without throwing', () => {
        for (const bad of ['', '7', '7.', '.abc', 'x.' + 'a'.repeat(32), '0.' + 'a'.repeat(32), '-1.' + 'a'.repeat(32), '7.' + 'a'.repeat(31), undefined as any, null as any]) {
            expect(parseClickToken(secret, bad)).toBeNull();
        }
    });

    it('accepts an upper-cased signature (mail clients sometimes re-case URLs)', () => {
        const t = signClickToken(secret, 99);
        const [id, sig] = t.split('.');
        expect(parseClickToken(secret, `${id}.${sig.toUpperCase()}`)).toBe(99);
    });
});
