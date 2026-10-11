/**
 * Signed review-link tokens.
 *
 * The review button in an invitation goes through
 * `GET /review-requests/r/<token>` so the plugin can record that the link
 * was clicked before redirecting to the real review page. The token is the
 * `review_log` row id plus an HMAC over it, so a click can only be recorded
 * for a row the plugin itself wrote — nobody can mark arbitrary rows clicked
 * or probe ids. Pure functions; the secret comes from the service.
 */
import { createHmac, timingSafeEqual } from 'crypto';

const SIG_LEN = 32;

function signature(secret: string, logId: number): string {
    return createHmac('sha256', secret).update(`click|${logId}`).digest('hex').slice(0, SIG_LEN);
}

/** `<logId>.<hmac>` for the invitation's review link. */
export function signClickToken(secret: string, logId: number): string {
    return `${logId}.${signature(secret, logId)}`;
}

/** The `review_log` id a token stands for, or `null` when it is malformed
 *  or its signature does not match (constant-time compare). */
export function parseClickToken(secret: string, token: string): number | null {
    const m = /^(\d{1,12})\.([0-9a-f]{32})$/i.exec(String(token || ''));
    if (!m) return null;
    const logId = Number(m[1]);
    if (!Number.isSafeInteger(logId) || logId <= 0) return null;
    const expected = Buffer.from(signature(secret, logId));
    const given = Buffer.from(m[2].toLowerCase());
    try { return timingSafeEqual(given, expected) ? logId : null; } catch { return null; }
}
