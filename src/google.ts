import * as https from 'https';
import { TrustpilotRating } from './trustpilot';

/**
 * Google reviews live rating via the Google Places API (Place Details).
 * Needs a Google Maps API key with the Places API enabled and the
 * business's Place ID. Read-only; the review link itself is free.
 *
 *   GET /maps/api/place/details/json?place_id=..&fields=rating,user_ratings_total&key=..
 */
function getJson(url: string, timeoutMs = 6000): Promise<any> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: timeoutMs, headers: { accept: 'application/json' } }, res => {
            if (res.statusCode && res.statusCode >= 400) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
            let data = '';
            res.on('data', c => (data += c));
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

/** Returns null (fail open) on any error or missing rating. */
export async function fetchGoogleRating(placeId: string, apiKey: string): Promise<TrustpilotRating | null> {
    if (!placeId || !apiKey) return null;
    try {
        const j = await getJson(
            `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}` +
            `&fields=rating,user_ratings_total&key=${encodeURIComponent(apiKey)}`,
        );
        if (j?.status !== 'OK' || !j?.result) return null;
        const trustScore = Number(j.result.rating || 0);
        const numberOfReviews = Number(j.result.user_ratings_total || 0);
        if (!trustScore && !numberOfReviews) return null;
        return { stars: Math.round(trustScore), trustScore, numberOfReviews, fetchedAt: new Date().toISOString() };
    } catch {
        return null;
    }
}
