import { LicenceStore, adapterFor, PurchaseClaimClient } from '@huloglobal/vendure-licence-sdk';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Logger, TransactionalConnection } from '@vendure/core';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import * as nodemailer from 'nodemailer';

import { DEFAULT_CONFIG, ReviewChannelConfig, ReviewPluginOptions, TriggerState } from './types';
import { DEFAULT_TEMPLATE, Template, renderTemplate, wrapEmail, escapeHtml } from './templates';
import { buildReviewUrl, fetchRating, findBusinessUnitId, formatScore, renderStars, TrustpilotRating } from './trustpilot';
import { fetchGoogleRating } from './google';

const loggerCtx = 'ReviewRequests';

/** Days beyond `delayDays` an order stays a candidate (slow carriers, worker downtime). */
const LOOKBACK_DAYS = 45;

@Injectable()
export class ReviewRequestService implements OnModuleInit {
    private options: ReviewPluginOptions = {};
    setOptions(o: ReviewPluginOptions) { this.options = o; }
    getOptions() { return this.options; }

    constructor(private connection: TransactionalConnection) {}

    private get db() { return adapterFor(this.connection.rawConnection); }

    private licenceStore = new LicenceStore((sql, params) => this.db.query(sql, params));

    // Buy-from-admin auto-install (hooks are supplied by the controller so
    // this file never imports the plugin class).
    private purchaseClaim: PurchaseClaimClient | null = null;
    initPurchaseClaim(hooks: { packageName: string; instanceId: () => string | null; onLicence: (key: string) => Promise<boolean> }): PurchaseClaimClient {
        if (!this.purchaseClaim) {
            this.purchaseClaim = new PurchaseClaimClient({ ...hooks, query: (sql, params, opts) => this.db.query(sql, params, opts) });
        }
        return this.purchaseClaim;
    }

    async loadStoredLicenceKey(): Promise<string | null> {
        await this.licenceStore.ensureTable();
        return this.licenceStore.load('vendure-plugin-review-requests');
    }

    async saveStoredLicenceKey(key: string): Promise<void> {
        await this.licenceStore.ensureTable();
        await this.licenceStore.save('vendure-plugin-review-requests', key);
    }

    async clearStoredLicenceKey(): Promise<void> {
        await this.licenceStore.clear('vendure-plugin-review-requests');
    }

    /** Anonymous usage aggregates for the evaluation drip (numbers only). */
    async evalStats(): Promise<Record<string, number>> {
        const [row] = await this.db.query(`SELECT COUNT(*) AS n FROM review_log WHERE status = 'sent'`);
        return { invitesSent: Number(row?.n || 0) };
    }

    async onModuleInit() {
        try { await this.ensureSchema(); }
        catch (e: any) { Logger.error(`Schema init failed: ${e.message}`, loggerCtx); }
    }

    // ── Schema ──────────────────────────────────────────────────────────
    async ensureSchema() {
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS review_config (
                channelId INT PRIMARY KEY,
                enabled TINYINT NOT NULL DEFAULT 0,
                triggerState VARCHAR(24) NOT NULL DEFAULT 'Delivered',
                delayDays INT NOT NULL DEFAULT 14,
                minOrderValuePence INT NOT NULL DEFAULT 0,
                cooldownDays INT NOT NULL DEFAULT 120,
                trustpilotDomain VARCHAR(190) NOT NULL DEFAULT '',
                reviewUrlTemplate VARCHAR(400) NOT NULL DEFAULT 'https://www.trustpilot.com/evaluate/{domain}',
                trustpilotApiKey VARCHAR(190) NOT NULL DEFAULT '',
                trustpilotBusinessUnitId VARCHAR(64) NOT NULL DEFAULT '',
                businessName VARCHAR(190) NOT NULL DEFAULT '',
                replyTo VARCHAR(190) NOT NULL DEFAULT '',
                maxPerRun INT NOT NULL DEFAULT 200
            )`);
        await this.addColumnIfMissing('review_config', 'reviewMode', `VARCHAR(12) NOT NULL DEFAULT 'service'`);
        await this.addColumnIfMissing('review_config', 'productReviewUrlTemplate', `VARCHAR(400) NOT NULL DEFAULT ''`);
        // One row per order that is being (or has been) invited: claimed BEFORE the
        // email goes out so the hourly cron (worker) and "Send due now" (server)
        // cannot both send for the same order.
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS review_claim (
                orderId INT PRIMARY KEY,
                channelId INT NULL,
                claimedAt DATETIME NOT NULL
            )`);
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS review_template (
                channelId INT PRIMARY KEY,
                subject VARCHAR(255),
                body MEDIUMTEXT
            )`);
        await this.widenTemplateBody();
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS review_log (
                id INT AUTO_INCREMENT PRIMARY KEY,
                orderId INT NOT NULL,
                orderCode VARCHAR(32),
                channelId INT,
                email VARCHAR(255),
                status VARCHAR(16) NOT NULL,
                reason VARCHAR(255),
                reviewUrl VARCHAR(500),
                createdAt DATETIME NOT NULL,
                INDEX idx_rl_order (orderId),
                INDEX idx_rl_email (email, createdAt),
                INDEX idx_rl_created (createdAt),
                INDEX idx_rl_status (status, createdAt)
            )`);
        for (const ddl of ['CREATE INDEX IF NOT EXISTS idx_rl_status ON review_log (status, createdAt)']) { try { await this.db.query(ddl); } catch { /* exists */ } }
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS review_exclusion (
                id INT AUTO_INCREMENT PRIMARY KEY,
                type VARCHAR(16) NOT NULL,
                value VARCHAR(255) NOT NULL,
                note VARCHAR(255),
                createdAt DATETIME NOT NULL,
                INDEX idx_re_val (type, value)
            )`);
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS review_optout (
                email VARCHAR(255) PRIMARY KEY,
                createdAt DATETIME NOT NULL
            )`);
    }

    // ── Config ──────────────────────────────────────────────────────────
    /** `ADD COLUMN IF NOT EXISTS` is MariaDB/Postgres syntax; MySQL 8 needs the check up front. */
    private async addColumnIfMissing(table: string, column: string, ddl: string): Promise<void> {
        const scope = this.db.dialect === 'postgres' ? 'table_catalog = current_database() AND table_schema = current_schema()' : 'table_schema = DATABASE()';
        const rows: any[] = await this.db.query(
            `SELECT COUNT(*) AS n FROM information_schema.columns WHERE ${scope} AND LOWER(table_name) = LOWER(?) AND LOWER(column_name) = LOWER(?)`, [table, column],
        ).catch(() => []);
        if (Number(rows?.[0]?.n ?? rows?.[0]?.N ?? 0) > 0) return;
        try { await this.db.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`); }
        catch (e: any) { if (!/duplicate|exists/i.test(String(e?.message || ''))) throw e; }
    }

    /** `review_template.body` started life as TEXT (64 KB on MySQL/MariaDB) — a template with
     *  inlined images silently truncated. Widen to MEDIUMTEXT once; Postgres TEXT is unbounded. */
    private async widenTemplateBody(): Promise<void> {
        if (this.db.dialect === 'postgres') return;
        const rows: any[] = await this.db.query(
            `SELECT DATA_TYPE AS dataType FROM information_schema.columns
             WHERE table_schema = DATABASE() AND LOWER(table_name) = 'review_template' AND LOWER(column_name) = 'body'`,
        ).catch(() => []);
        const type = String(rows?.[0]?.dataType ?? rows?.[0]?.DATA_TYPE ?? '').toLowerCase();
        if (type !== 'text' && type !== 'tinytext') return;
        try { await this.db.query(`ALTER TABLE review_template MODIFY body MEDIUMTEXT`); }
        catch (e: any) { Logger.warn(`could not widen review_template.body: ${e?.message}`, loggerCtx); }
    }

    /** Monthly housekeeping (worker): drop skipped/failed audit rows older than `months`
     *  in id-ordered batches. 'sent' rows are kept — they drive dedup and cooldown. */
    async pruneLog(months = 18, batch = 5000): Promise<number> {
        let deleted = 0;
        for (let round = 0; round < 400; round++) {
            const rows: any[] = await this.db.query(
                `SELECT id FROM review_log WHERE status <> 'sent' AND createdAt < DATE_SUB(NOW(), INTERVAL ? MONTH) ORDER BY id LIMIT ?`,
                [months, batch],
            );
            if (!rows.length) break;
            const ids = rows.map((r: any) => Number(r.id));
            await this.db.query(`DELETE FROM review_log WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
            deleted += ids.length;
            if (ids.length < batch) break;
        }
        return deleted;
    }

    /** Claim an order for sending; false when another process already has it. */
    private async claimOrder(orderId: number, channelId: number): Promise<boolean> {
        const r = await this.db.query(
            `INSERT IGNORE INTO review_claim (orderId, channelId, claimedAt) VALUES (?, ?, NOW())`, [orderId, channelId], { needAffected: true },
        ).catch(() => null);
        return Number(r?.affectedRows ?? r?.rowCount ?? 0) > 0;
    }

    private async releaseClaim(orderId: number): Promise<void> {
        await this.db.query(`DELETE FROM review_claim WHERE orderId = ?`, [orderId]).catch(() => undefined);
    }

    /** The order states at or beyond the configured trigger (an order delivered 14 days ago is no longer "PaymentSettled"). */
    static statesFor(trigger: string): string[] {
        return ({
            PaymentSettled: ['PaymentSettled', 'PartiallyShipped', 'Shipped', 'PartiallyDelivered', 'Delivered'],
            Shipped: ['Shipped', 'PartiallyDelivered', 'Delivered'],
            Delivered: ['Delivered'],
        } as Record<string, string[]>)[trigger] || ['Delivered'];
    }

    private rowToConfig(row: any, code?: string): ReviewChannelConfig {
        return {
            channelId: row.channelId,
            channelCode: code,
            enabled: !!row.enabled,
            triggerState: (['Delivered', 'PaymentSettled', 'Shipped'].includes(row.triggerState) ? row.triggerState : 'Delivered') as TriggerState,
            delayDays: row.delayDays ?? DEFAULT_CONFIG.delayDays,
            minOrderValuePence: row.minOrderValuePence ?? 0,
            cooldownDays: row.cooldownDays ?? DEFAULT_CONFIG.cooldownDays,
            trustpilotDomain: row.trustpilotDomain || '',
            reviewUrlTemplate: row.reviewUrlTemplate || DEFAULT_CONFIG.reviewUrlTemplate,
            trustpilotApiKey: row.trustpilotApiKey || '',
            trustpilotBusinessUnitId: row.trustpilotBusinessUnitId || '',
            businessName: row.businessName || '',
            replyTo: row.replyTo || '',
            maxPerRun: row.maxPerRun ?? DEFAULT_CONFIG.maxPerRun,
            reviewMode: (['service', 'product', 'both'].includes(row.reviewMode) ? row.reviewMode : 'service'),
            productReviewUrlTemplate: row.productReviewUrlTemplate || '',
        };
    }

    async getAllConfigs(): Promise<ReviewChannelConfig[]> {
        const channels = await this.db.query(`SELECT id AS channelId, code AS channelCode FROM channel ORDER BY id`);
        const rows = await this.db.query(`SELECT * FROM review_config`).catch(() => []);
        return channels.map((ch: any) => {
            const existing = rows.find((r: any) => r.channelId === ch.channelId);
            return existing ? this.rowToConfig(existing, ch.channelCode)
                : { ...DEFAULT_CONFIG, channelId: ch.channelId, channelCode: ch.channelCode };
        });
    }

    async getConfig(channelId: number): Promise<ReviewChannelConfig> {
        const rows = await this.db.query(`SELECT * FROM review_config WHERE channelId = ?`, [channelId]).catch(() => []);
        return rows.length ? this.rowToConfig(rows[0]) : { ...DEFAULT_CONFIG, channelId };
    }

    async saveConfig(c: ReviewChannelConfig): Promise<void> {
        await this.db.query(
            `INSERT INTO review_config (channelId, enabled, triggerState, delayDays, minOrderValuePence, cooldownDays,
                trustpilotDomain, reviewUrlTemplate, trustpilotApiKey, trustpilotBusinessUnitId, businessName, replyTo, maxPerRun,
                reviewMode, productReviewUrlTemplate)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE enabled=VALUES(enabled), triggerState=VALUES(triggerState), delayDays=VALUES(delayDays),
                minOrderValuePence=VALUES(minOrderValuePence), cooldownDays=VALUES(cooldownDays),
                trustpilotDomain=VALUES(trustpilotDomain), reviewUrlTemplate=VALUES(reviewUrlTemplate),
                trustpilotApiKey=VALUES(trustpilotApiKey), trustpilotBusinessUnitId=VALUES(trustpilotBusinessUnitId),
                businessName=VALUES(businessName), replyTo=VALUES(replyTo), maxPerRun=VALUES(maxPerRun),
                reviewMode=VALUES(reviewMode), productReviewUrlTemplate=VALUES(productReviewUrlTemplate)`,
            [c.channelId, c.enabled ? 1 : 0, c.triggerState, c.delayDays, c.minOrderValuePence, c.cooldownDays,
             c.trustpilotDomain || '', c.reviewUrlTemplate || DEFAULT_CONFIG.reviewUrlTemplate, c.trustpilotApiKey || '',
             c.trustpilotBusinessUnitId || '', c.businessName || '', c.replyTo || '', c.maxPerRun || 200,
             c.reviewMode || 'service', c.productReviewUrlTemplate || ''],
            { conflictColumns: ['channelId'] },
        );
        this.invalidatePending();
    }

    // ── Pending (dry-run) summary, memoised ─────────────────────────────
    // `GET /stats` used to run the full candidate scan on every Overview /
    // Exclusions tab open. The result is held for 60 s and dropped after
    // anything that changes eligibility (a real run, a manual send, a config
    // or exclusion change), and concurrent callers share one scan.
    private pendingCache: { at: number; value: any[] } | null = null;
    private pendingInFlight: Promise<any[]> | null = null;
    private static readonly PENDING_TTL_MS = 60_000;

    async pendingSummary(): Promise<any[]> {
        if (this.pendingCache && Date.now() - this.pendingCache.at < ReviewRequestService.PENDING_TTL_MS) return this.pendingCache.value;
        if (this.pendingInFlight) return this.pendingInFlight;
        this.pendingInFlight = this.runAll(true)
            .then(value => { this.pendingCache = { at: Date.now(), value }; return value; })
            .finally(() => { this.pendingInFlight = null; });
        return this.pendingInFlight;
    }

    invalidatePending(): void { this.pendingCache = null; }

    // ── Template ────────────────────────────────────────────────────────
    async getTemplate(channelId: number): Promise<Template & { isDefault: boolean }> {
        const rows = await this.db.query(`SELECT subject, body FROM review_template WHERE channelId = ?`, [channelId]).catch(() => []);
        return rows.length ? { subject: rows[0].subject, body: rows[0].body, isDefault: false }
            : { ...DEFAULT_TEMPLATE, isDefault: true };
    }
    async saveTemplate(channelId: number, subject: string, body: string): Promise<void> {
        await this.db.query(
            `INSERT INTO review_template (channelId, subject, body) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE subject = VALUES(subject), body = VALUES(body)`,
            [channelId, subject, body],
            { conflictColumns: ['channelId'] },
        );
    }
    async resetTemplate(channelId: number): Promise<void> {
        await this.db.query(`DELETE FROM review_template WHERE channelId = ?`, [channelId]);
    }

    // ── Exclusions + opt-out ────────────────────────────────────────────
    async listExclusions(): Promise<any[]> {
        return this.db.query(`SELECT * FROM review_exclusion ORDER BY createdAt DESC LIMIT 500`).catch(() => []);
    }
    async addExclusion(type: string, value: string, note?: string): Promise<void> {
        const t = type === 'email_domain' ? 'email_domain' : 'email';
        const v = String(value || '').trim().toLowerCase();
        if (!v) throw new Error('empty value');
        await this.db.query(`INSERT INTO review_exclusion (type, value, note, createdAt) VALUES (?, ?, ?, NOW())`, [t, v, note || '']);
        this.invalidatePending();
    }
    async removeExclusion(id: number): Promise<void> {
        await this.db.query(`DELETE FROM review_exclusion WHERE id = ?`, [id]);
        this.invalidatePending();
    }

    /** Is this email excluded, and via what? Used by the admin "check". */
    async checkExcluded(email: string): Promise<{ excluded: boolean; via: string | null }> {
        const e = String(email || '').toLowerCase();
        const domain = e.split('@')[1] || '';
        const [opt] = await this.db.query(`SELECT email FROM review_optout WHERE email = ? LIMIT 1`, [e]).catch(() => []);
        if (opt) return { excluded: true, via: 'unsubscribed' };
        const ex = await this.db.query(
            `SELECT type FROM review_exclusion WHERE (type='email' AND value=?) OR (type='email_domain' AND value=?) LIMIT 1`,
            [e, domain],
        ).catch(() => []);
        if (ex.length) return { excluded: true, via: ex[0].type === 'email_domain' ? 'domain rule' : 'excluded' };
        return { excluded: false, via: null };
    }

    /** Live customer search with a batched "already excluded?" flag per row. */
    async searchCustomers(q: string, limit = 10): Promise<any[]> {
        const term = String(q || '').trim();
        if (term.length < 2) return [];
        const like = `%${term}%`;
        const rows = await this.db.query(
            `SELECT id, \`firstName\`, \`lastName\`, \`emailAddress\` FROM customer
             WHERE \`deletedAt\` IS NULL
               AND (\`emailAddress\` LIKE ? OR \`firstName\` LIKE ? OR \`lastName\` LIKE ? OR CONCAT(\`firstName\`, ' ', \`lastName\`) LIKE ?)
             ORDER BY (LOWER(\`emailAddress\`) = ?) DESC, id DESC
             LIMIT ?`,
            [like, like, like, like, term.toLowerCase(), Math.min(limit, 25)],
        ).catch(() => []);
        if (!rows.length) return [];
        const emails = rows.map((r: any) => String(r.emailAddress || '').toLowerCase());
        const domains = [...new Set(emails.map((e: string) => e.split('@')[1]).filter(Boolean))];
        const emailPh = emails.map(() => '?').join(',');
        const domPh = domains.length ? domains.map(() => '?').join(',') : "''";
        const exRows = await this.db.query(
            `SELECT type, value FROM review_exclusion
             WHERE (type='email' AND value IN (${emailPh})) OR (type='email_domain' AND value IN (${domPh}))`,
            [...emails, ...(domains.length ? domains : [])],
        ).catch(() => []);
        const optRows = await this.db.query(`SELECT email FROM review_optout WHERE email IN (${emailPh})`, emails).catch(() => []);
        const exEmails = new Set(exRows.filter((r: any) => r.type === 'email').map((r: any) => r.value));
        const exDomains = new Set(exRows.filter((r: any) => r.type === 'email_domain').map((r: any) => r.value));
        const optSet = new Set(optRows.map((r: any) => r.email));
        return rows.map((r: any) => {
            const e = String(r.emailAddress || '').toLowerCase();
            const d = e.split('@')[1] || '';
            const via = optSet.has(e) ? 'unsubscribed' : exEmails.has(e) ? 'excluded' : exDomains.has(d) ? 'domain rule' : null;
            return { id: r.id, firstName: r.firstName, lastName: r.lastName, email: r.emailAddress, excluded: !!via, via };
        });
    }

    async isExcluded(email: string): Promise<boolean> {
        const e = email.toLowerCase();
        const domain = e.split('@')[1] || '';
        const [opt] = await this.db.query(`SELECT email FROM review_optout WHERE email = ? LIMIT 1`, [e]).catch(() => []);
        if (opt) return true;
        const ex = await this.db.query(
            `SELECT id FROM review_exclusion WHERE (type='email' AND value=?) OR (type='email_domain' AND value=?) LIMIT 1`,
            [e, domain],
        ).catch(() => []);
        return ex.length > 0;
    }

    private optOutSecretCache: string | null = null;

    /** The HMAC secret for unsubscribe links: configured, else a per-install
     *  random one persisted in the licence store (never the literal default
     *  every install used to share, which let anyone forge opt-outs). */
    private async optOutSecret(): Promise<string> {
        const configured = this.options.optOutSecret || process.env.HULO_IP_SALT;
        if (configured) return configured;
        if (this.optOutSecretCache) return this.optOutSecretCache;
        const store = new LicenceStore((sql, params) => this.db.query(sql, params));
        try {
            let s = await store.load('review-requests-optout-secret');
            if (!s) {
                await store.save('review-requests-optout-secret', randomBytes(32).toString('hex'));
                s = await store.load('review-requests-optout-secret'); // re-read: another process may have won
            }
            if (s) { this.optOutSecretCache = s; return s; }
        } catch (e: any) {
            Logger.warn(`optout secret store unavailable: ${e?.message}`, loggerCtx);
        }
        return 'hulo-review-optout';
    }

    async optOutToken(email: string): Promise<string> {
        const secret = await this.optOutSecret();
        return createHmac('sha256', secret).update(email.toLowerCase()).digest('hex').slice(0, 32);
    }
    async optOutUrl(email: string): Promise<string> {
        const base = (this.options.publicBaseUrl || '').replace(/\/$/, '');
        if (!base) return '';
        return `${base}/review-requests/optout?e=${encodeURIComponent(email)}&t=${await this.optOutToken(email)}`;
    }
    /** Token check without applying (the GET confirmation page). */
    async optOutTokenValid(email: string, token: string): Promise<boolean> {
        const e = String(email || '').toLowerCase();
        if (!e || !/^[0-9a-f]{32}$/i.test(String(token || ''))) return false;
        const expected = await this.optOutToken(e);
        try { return timingSafeEqual(Buffer.from(String(token).toLowerCase()), Buffer.from(expected)); } catch { return false; }
    }
    async optOut(email: string, token: string): Promise<boolean> {
        const e = String(email || '').toLowerCase();
        if (!(await this.optOutTokenValid(e, token))) return false;
        await this.db.query(`INSERT IGNORE INTO review_optout (email, createdAt) VALUES (?, NOW())`, [e]);
        this.invalidatePending();
        return true;
    }

    // ── Review rating (Trustpilot or Google, cached in memory) ──────────
    // A successful lookup is held for 6 h; a failed one (bad key, outage,
    // timeout) for 10 min so a transient error does not blank the star
    // block out of every email until the next restart.
    private ratingCache = new Map<string, { rating: TrustpilotRating | null; at: number }>();
    private static readonly RATING_OK_TTL_MS = 6 * 3600_000;
    private static readonly RATING_FAIL_TTL_MS = 10 * 60_000;

    /** Which review platform a config targets, inferred from its link. */
    platformOf(cfg: ReviewChannelConfig): 'trustpilot' | 'google' | 'other' {
        const t = cfg.reviewUrlTemplate || '';
        if (t.includes('google.com')) return 'google';
        if (t.includes('trustpilot.com')) return 'trustpilot';
        return 'other';
    }
    platformName(cfg: ReviewChannelConfig): string {
        const p = this.platformOf(cfg);
        return p === 'google' ? 'Google' : p === 'trustpilot' ? 'Trustpilot' : (cfg.businessName || 'us');
    }

    /** Live rating for a channel. `cache: false` (the admin "check" button, which posts
     *  whatever key/domain is in the form) neither reads nor writes the shared cache. */
    async getRating(cfg: ReviewChannelConfig, opts: { cache?: boolean } = {}): Promise<TrustpilotRating | null> {
        const platform = this.platformOf(cfg);
        if (!cfg.trustpilotApiKey || !cfg.trustpilotDomain) return null;
        const useCache = opts.cache !== false;
        const cacheKey = `${platform}|${cfg.trustpilotDomain}|${cfg.trustpilotBusinessUnitId}`;
        if (useCache) {
            const hit = this.ratingCache.get(cacheKey);
            const ttl = hit?.rating ? ReviewRequestService.RATING_OK_TTL_MS : ReviewRequestService.RATING_FAIL_TTL_MS;
            if (hit && Date.now() - hit.at < ttl) return hit.rating;
        }

        let rating: TrustpilotRating | null = null;
        if (platform === 'google') {
            // For Google the identifier field holds the Place ID.
            rating = await fetchGoogleRating(cfg.trustpilotDomain, cfg.trustpilotApiKey);
        } else if (platform === 'trustpilot') {
            let unitId = cfg.trustpilotBusinessUnitId;
            if (!unitId) unitId = (await findBusinessUnitId(cfg.trustpilotDomain, cfg.trustpilotApiKey)) || '';
            rating = unitId ? await fetchRating(unitId, cfg.trustpilotApiKey) : null;
        }
        if (useCache) {
            if (this.ratingCache.size > 200) this.ratingCache.clear();
            this.ratingCache.set(cacheKey, { rating, at: Date.now() });
        }
        return rating;
    }

    /** One-shot auto-detect: from a domain (+ optional free API key) resolve
     *  the review link, the business-unit id and the live rating — so the
     *  admin "Connect" button fills everything in without manual lookups. */
    async detect(domain: string, apiKey: string, template?: string): Promise<{ ok: boolean; reviewUrl: string; businessUnitId: string; rating: TrustpilotRating | null; message: string }> {
        const tpl = template || DEFAULT_CONFIG.reviewUrlTemplate;
        const reviewUrl = buildReviewUrl(tpl, domain);
        const isGoogle = tpl.includes('google.com');
        const isTrustpilot = tpl.includes('trustpilot.com');
        let businessUnitId = '';
        let rating: TrustpilotRating | null = null;
        if (domain && apiKey && isGoogle) {
            rating = await fetchGoogleRating(domain, apiKey);
            this.ratingCache.delete(`google|${domain}|`);
        } else if (domain && apiKey && isTrustpilot) {
            businessUnitId = (await findBusinessUnitId(domain, apiKey)) || '';
            if (businessUnitId) rating = await fetchRating(businessUnitId, apiKey);
            this.ratingCache.delete(`trustpilot|${domain}|${businessUnitId}`);
        }
        const platformLabel = isGoogle ? 'Google Place ID' : isTrustpilot ? 'Trustpilot domain' : 'identifier';
        const message = !domain ? `Enter your ${platformLabel} first.`
            : !apiKey ? 'Review link ready. Add an API key to also show your star rating in emails.'
            : rating ? `Connected — ${formatScore(rating)}★ from ${rating.numberOfReviews.toLocaleString()} reviews.`
            : (isGoogle || isTrustpilot) ? `Couldn't read a rating — check the ${platformLabel} + API key.`
            : 'Review link ready (this platform has no live-rating lookup).';
        return { ok: !!reviewUrl, reviewUrl, businessUnitId, rating, message };
    }

    // ── Compose + send one invitation ───────────────────────────────────
    private smtp() {
        if (this.options.smtp) return this.options.smtp;
        if (process.env.SMTP_SERVER && process.env.SMTP_USER) {
            return {
                host: process.env.SMTP_SERVER, port: Number(process.env.SMTP_PORT || 587),
                user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '',
                from: process.env.SMTP_FROM || process.env.SMTP_USER,
            };
        }
        return null;
    }

    /** Products on an order (name + slug), for product-review links. */
    async getOrderProducts(orderId: number): Promise<Array<{ name: string; slug: string }>> {
        if (!orderId) return [];
        return this.db.query(
            `SELECT DISTINCT pt.name, pt.slug
             FROM order_line ol
             JOIN product_variant pv ON pv.id = ol.\`productVariantId\`
             JOIN product p ON p.id = pv.\`productId\`
             JOIN product_translation pt ON pt.\`baseId\` = p.id AND pt.\`languageCode\` = 'en'
             WHERE ol.\`orderId\` = ?
             LIMIT 20`,
            [orderId],
        ).catch(() => []);
    }

    private productReviewUrl(template: string, slug: string, name: string, orderCode: string): string {
        return String(template || '')
            .replace(/\{slug\}/g, encodeURIComponent(slug || ''))
            .replace(/\{name\}/g, encodeURIComponent(name || ''))
            .replace(/\{orderCode\}/g, encodeURIComponent(orderCode || ''));
    }

    private renderProductList(products: Array<{ name: string; slug: string }>, template: string, orderCode: string): string {
        if (!products.length || !template) return '';
        const rows = products.map(p => {
            const url = this.productReviewUrl(template, p.slug, p.name, orderCode);
            return `<tr>
                <td style="padding:8px 0;font-size:14px;color:#0f172a">${escapeHtml(p.name)}</td>
                <td style="padding:8px 0;text-align:right"><a href="${url}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;font-weight:600;font-size:13px;padding:8px 16px;border-radius:6px">Review this</a></td>
            </tr>`;
        }).join('');
        return `<div style="margin:0 0 22px">
            <p style="text-align:center;font-weight:600;font-size:14px;margin:0 0 6px;color:#0f172a">Tell others about what you bought</p>
            <table style="width:100%;border-collapse:collapse">${rows}</table>
        </div>`;
    }

    async composeEmail(cfg: ReviewChannelConfig, to: string, firstName: string, orderCode: string, orderId = 0): Promise<{ subject: string; html: string; unsubscribeUrl: string } | null> {
        const tpl = await this.getTemplate(cfg.channelId);
        const reviewUrl = buildReviewUrl(cfg.reviewUrlTemplate, cfg.trustpilotDomain);
        const rating = await this.getRating(cfg);
        const businessName = cfg.businessName || cfg.trustpilotDomain || 'us';
        const wantService = cfg.reviewMode === 'service' || cfg.reviewMode === 'both';
        const wantProduct = cfg.reviewMode === 'product' || cfg.reviewMode === 'both';

        const ratingBlock = (wantService && rating && Number.isFinite(rating.trustScore))
            ? `<div style="text-align:center;margin:0 0 18px">${renderStars(rating.stars)}` +
              `<div style="font-size:13px;color:#475569;margin-top:6px">Rated <strong>${formatScore(rating)}</strong> by ${rating.numberOfReviews.toLocaleString()} customers on ${this.platformName(cfg)}</div></div>`
            : '';
        const reviewButton = wantService
            ? `<p style="margin:0 0 22px;text-align:center"><a href="${reviewUrl}" style="display:inline-block;background:#00b67a;color:#fff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:8px">★ Leave a review</a></p>`
            : '';
        let productList = '';
        if (wantProduct && cfg.productReviewUrlTemplate) {
            const products = orderId ? await this.getOrderProducts(orderId)
                : [{ name: 'Sample Product A', slug: 'sample-a' }, { name: 'Sample Product B', slug: 'sample-b' }];
            productList = this.renderProductList(products, cfg.productReviewUrlTemplate, orderCode);
        }

        const unsubscribeUrl = await this.optOutUrl(to);
        const vars = {
            firstName: escapeHtml(firstName || 'there'), orderCode: escapeHtml(orderCode), businessName,
            reviewUrl, ratingBlock, reviewButton, productList,
            unsubscribeUrl,
        };
        const subject = renderTemplate(tpl.subject, { ...vars, firstName: firstName || 'there', orderCode });
        const bodyHtml = renderTemplate(tpl.body, vars);
        const html = wrapEmail(bodyHtml, businessName, unsubscribeUrl);
        return { subject, html, unsubscribeUrl };
    }

    async sendInvitation(cfg: ReviewChannelConfig, order: { id: number; code: string; email: string; firstName: string }): Promise<{ ok: boolean; reason?: string }> {
        const smtp = this.smtp();
        if (!smtp) return { ok: false, reason: 'SMTP not configured' };
        const composed = await this.composeEmail(cfg, order.email, order.firstName, order.code, order.id);
        if (!composed) return { ok: false, reason: 'compose failed' };
        if (!composed.unsubscribeUrl) return { ok: false, reason: 'publicBaseUrl not configured — refusing to send without an unsubscribe link' };
        try {
            const transporter = this.transporter(smtp);
            await transporter.sendMail({
                from: cfg.businessName ? `"${cfg.businessName.replace(/"/g, "'")}" <${smtp.from}>` : smtp.from,
                to: order.email,
                replyTo: cfg.replyTo || undefined,
                subject: composed.subject,
                html: composed.html,
                headers: {
                    'List-Unsubscribe': `<${composed.unsubscribeUrl}>`,
                    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                    Precedence: 'bulk',
                },
            });
            return { ok: true };
        } catch (e: any) {
            try { this.transportCache?.t.close(); } catch { /* ignore */ }
            this.transportCache = null;
            return { ok: false, reason: String(e?.message || e).slice(0, 255) };
        }
    }

    private transportCache: { key: string; t: nodemailer.Transporter } | null = null;

    /** One pooled transport per SMTP settings tuple, with timeouts (defaults are 2 min / 10 min). */
    private transporter(smtp: { host: string; port: number; user?: string; pass?: string; from: string }): nodemailer.Transporter {
        const key = [smtp.host, smtp.port, smtp.user || '', smtp.pass || ''].join('|');
        if (this.transportCache?.key === key) return this.transportCache.t;
        try { this.transportCache?.t.close(); } catch { /* ignore */ }
        const t = nodemailer.createTransport({
            host: smtp.host, port: smtp.port, secure: smtp.port === 465, requireTLS: smtp.port !== 465,
            auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
            pool: true, maxConnections: 2, maxMessages: 100,
            connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000,
        } as any);
        this.transportCache = { key, t };
        return t;
    }

    async logSend(orderId: number, orderCode: string, channelId: number, email: string, status: string, reason: string, reviewUrl: string) {
        await this.db.query(
            `INSERT INTO review_log (orderId, orderCode, channelId, email, status, reason, reviewUrl, createdAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
            [orderId, String(orderCode || '').slice(0, 32), channelId, String(email || '').slice(0, 255), status, String(reason || '').slice(0, 255), String(reviewUrl || '').slice(0, 500)],
        );
    }

    // ── Eligibility scan (the cron's engine) ────────────────────────────
    /** Opt-out + exclusion + cooldown sets for a batch of (lowercased) emails: three
     *  IN (…) queries regardless of batch size. Same pattern as `searchCustomers`. */
    private async batchEligibility(emails: string[], cooldownDays: number): Promise<{ excluded: Set<string>; cooldown: Set<string> }> {
        const excluded = new Set<string>();
        const cooldown = new Set<string>();
        if (!emails.length) return { excluded, cooldown };
        const domains = [...new Set(emails.map(e => e.split('@')[1]).filter(Boolean))];
        const emailPh = emails.map(() => '?').join(',');
        const domPh = domains.length ? domains.map(() => '?').join(',') : "''";
        const optRows: any[] = await this.db.query(`SELECT email FROM review_optout WHERE email IN (${emailPh})`, emails);
        for (const r of optRows) excluded.add(String(r.email || '').toLowerCase());
        const exRows: any[] = await this.db.query(
            `SELECT type, value FROM review_exclusion
             WHERE (type='email' AND value IN (${emailPh})) OR (type='email_domain' AND value IN (${domPh}))`,
            [...emails, ...domains],
        );
        const exDomains = new Set<string>();
        for (const r of exRows) {
            const v = String(r.value || '').toLowerCase();
            if (r.type === 'email_domain') exDomains.add(v); else excluded.add(v);
        }
        if (exDomains.size) for (const e of emails) if (exDomains.has(e.split('@')[1] || '')) excluded.add(e);
        if (cooldownDays > 0) {
            const cdRows: any[] = await this.db.query(
                `SELECT DISTINCT email FROM review_log
                 WHERE status = 'sent' AND createdAt > DATE_SUB(NOW(), INTERVAL ? DAY) AND email IN (${emailPh})`,
                [cooldownDays, ...emails],
            );
            for (const r of cdRows) cooldown.add(String(r.email || '').toLowerCase());
        }
        return { excluded, cooldown };
    }

    /**
     * Find orders placed ~delayDays ago that reached the trigger state, aren't
     * excluded / in cooldown / already invited, and send the invitation.
     * Returns a per-channel summary. `dryRun` computes eligibility without
     * sending (used for the Overview "pending" count and preview).
     */
    async runChannel(cfg: ReviewChannelConfig, dryRun = false): Promise<{ sent: number; skipped: number; failed: number; eligible: number }> {
        const out = { sent: 0, skipped: 0, failed: 0, eligible: 0 };
        if (!cfg.enabled && !dryRun) return out;

        // Candidate window: placed at least delayDays ago, within a 45-day
        // lookback (slow carriers, worker downtime). Orders already invited are
        // excluded in SQL so LIMIT counts real work. Backticks keep Vendure's
        // camelCase columns intact on Postgres.
        const states = ReviewRequestService.statesFor(cfg.triggerState);
        const orders = await this.db.query(
            `SELECT o.id, o.code, o.state, o.\`subTotalWithTax\`, o.\`orderPlacedAt\`, c.\`emailAddress\` AS email, c.\`firstName\`
             FROM \`order\` o
             JOIN customer c ON c.id = o.\`customerId\`
             JOIN order_channels_channel occ ON occ.\`orderId\` = o.id AND occ.\`channelId\` = ?
             WHERE o.state IN (${states.map(() => '?').join(',')})
               AND o.\`orderPlacedAt\` <= DATE_SUB(NOW(), INTERVAL ? DAY)
               AND o.\`orderPlacedAt\` >  DATE_SUB(NOW(), INTERVAL ? DAY)
               AND o.\`subTotalWithTax\` >= ?
               AND c.\`emailAddress\` IS NOT NULL AND c.\`emailAddress\` <> ''
               AND NOT EXISTS (SELECT 1 FROM review_log rl WHERE rl.orderId = o.id AND rl.status = 'sent')
               AND NOT EXISTS (SELECT 1 FROM review_claim rc WHERE rc.orderId = o.id)
             ORDER BY o.\`orderPlacedAt\` ASC
             LIMIT ?`,
            [cfg.channelId, ...states, cfg.delayDays, cfg.delayDays + LOOKBACK_DAYS, cfg.minOrderValuePence, cfg.maxPerRun],
        ).catch((e: any) => { Logger.error(`candidate query failed: ${e.message}`, loggerCtx); return []; });

        // Opt-out, exclusion and cooldown are resolved for the whole batch in three
        // IN (…) queries (the per-candidate lookups used to cost 3 round trips per order).
        const emails: string[] = [...new Set<string>(orders.map((o: any) => String(o.email || '').toLowerCase()).filter(Boolean))];
        let gate: { excluded: Set<string>; cooldown: Set<string> };
        try { gate = await this.batchEligibility(emails, cfg.cooldownDays); }
        catch (e: any) {
            // Fail closed: without the exclusion/cooldown sets we could email people who asked us not to.
            Logger.error(`eligibility lookup failed for channel ${cfg.channelId}: ${e?.message || e}`, loggerCtx);
            return out;
        }

        for (const o of orders) {
          try {
            const email = String(o.email).toLowerCase();
            // Log each skip reason at most once per order: the hourly scan
            // re-visits every order for its whole lookback window, and
            // repeating identical skip rows only buries the audit trail.
            const logSkipOnce = async (reason: string) => {
                if (dryRun) return;
                const [already] = await this.db.query(
                    `SELECT id FROM review_log WHERE orderId = ? AND status = 'skipped' AND reason = ? LIMIT 1`,
                    [o.id, reason],
                );
                if (!already) await this.logSend(o.id, o.code, cfg.channelId, email, 'skipped', reason, '');
            };
            // excluded / opted out?
            if (gate.excluded.has(email)) {
                await logSkipOnce('excluded');
                out.skipped++; continue;
            }
            // cooldown: invited (any order) within cooldownDays?
            if (gate.cooldown.has(email)) {
                await logSkipOnce('cooldown');
                out.skipped++; continue;
            }
            out.eligible++;
            if (dryRun) continue;
            if (!(await this.claimOrder(Number(o.id), cfg.channelId))) continue; // another process has it
            const reviewUrl = buildReviewUrl(cfg.reviewUrlTemplate, cfg.trustpilotDomain);
            const res = await this.sendInvitation(cfg, { id: o.id, code: o.code, email, firstName: o.firstName });
            if (res.ok) { await this.logSend(o.id, o.code, cfg.channelId, email, 'sent', '', reviewUrl); out.sent++; }
            else { await this.logSend(o.id, o.code, cfg.channelId, email, 'failed', res.reason || 'send failed', reviewUrl); await this.releaseClaim(Number(o.id)); out.failed++; }
          } catch (e: any) {
            Logger.error(`review invitation for order ${o?.code || o?.id} failed: ${e?.message || e}`, loggerCtx);
            out.failed++;
          }
        }
        return out;
    }

    async runAll(dryRun = false): Promise<any[]> {
        // Every order also sits in the default channel: run the storefront channels first so their branding wins.
        const configs = (await this.getAllConfigs()).slice().sort((a: any, b: any) => Number(a.channelCode === '__default_channel__') - Number(b.channelCode === '__default_channel__'));
        const results = [];
        for (const cfg of configs) {
            if (!cfg.enabled) continue;
            results.push({ channelId: cfg.channelId, channelCode: cfg.channelCode, ...(await this.runChannel(cfg, dryRun)) });
        }
        if (!dryRun) this.invalidatePending();
        return results;
    }

    /** Per-order invitation state for the admin order-detail panel. */
    async orderReviewStatus(orderId: number): Promise<any> {
        const [order] = await this.db.query(
            `SELECT o.id, o.code, o.state, c.\`emailAddress\` AS email, c.\`firstName\`,
                    (SELECT occ.\`channelId\` FROM order_channels_channel occ JOIN channel ch ON ch.id = occ.\`channelId\` WHERE occ.\`orderId\` = o.id ORDER BY (ch.code = '__default_channel__') ASC, occ.\`channelId\` DESC LIMIT 1) AS channelId
             FROM \`order\` o JOIN customer c ON c.id = o.\`customerId\` WHERE o.id = ? LIMIT 1`, [orderId]).catch(() => []);
        if (!order) return { found: false };
        const email = String(order.email || '').toLowerCase();
        const history = await this.db.query(
            `SELECT status, reason, createdAt FROM review_log WHERE orderId = ? ORDER BY createdAt DESC LIMIT 10`, [orderId]).catch(() => []);
        const [opt] = email ? await this.db.query(`SELECT email FROM review_optout WHERE email = ? LIMIT 1`, [email]).catch(() => []) : [];
        return {
            found: true,
            orderCode: order.code,
            email,
            sent: history.some((r: any) => r.status === 'sent'),
            optedOut: !!opt,
            excluded: email ? await this.isExcluded(email) : false,
            history,
        };
    }

    /** Manual send from the admin order page. Opt-outs are ALWAYS
     *  honoured; `force` re-sends an already-invited order and overrides
     *  exclusions (an explicit staff decision). */
    async sendForOrder(orderId: number, force = false): Promise<{ ok: boolean; reason?: string }> {
        const [o] = await this.db.query(
            `SELECT o.id, o.code, c.\`emailAddress\` AS email, c.\`firstName\`,
                    (SELECT occ.\`channelId\` FROM order_channels_channel occ JOIN channel ch ON ch.id = occ.\`channelId\` WHERE occ.\`orderId\` = o.id ORDER BY (ch.code = '__default_channel__') ASC, occ.\`channelId\` DESC LIMIT 1) AS channelId
             FROM \`order\` o JOIN customer c ON c.id = o.\`customerId\` WHERE o.id = ? LIMIT 1`, [orderId]).catch(() => []);
        if (!o) return { ok: false, reason: 'Order not found' };
        const email = String(o.email || '').toLowerCase();
        if (!email) return { ok: false, reason: 'Order has no customer email' };
        const [opt] = await this.db.query(`SELECT email FROM review_optout WHERE email = ? LIMIT 1`, [email]).catch(() => []);
        if (opt) return { ok: false, reason: 'Customer has opted out of review emails' };
        if (!force) {
            const [prior] = await this.db.query(`SELECT id FROM review_log WHERE orderId = ? AND status = 'sent' LIMIT 1`, [o.id]);
            if (prior) return { ok: false, reason: 'Already sent for this order — use Resend to send again' };
            if (await this.isExcluded(email)) return { ok: false, reason: 'Customer/domain is excluded — use Resend to override' };
        }
        const cfg = await this.getConfig(o.channelId);
        if (!cfg) return { ok: false, reason: 'No review configuration for this channel' };
        if (!force && !(await this.claimOrder(Number(o.id), cfg.channelId))) return { ok: false, reason: 'An invitation for this order is already being sent' };
        const reviewUrl = buildReviewUrl(cfg.reviewUrlTemplate, cfg.trustpilotDomain);
        const res = await this.sendInvitation(cfg, { id: o.id, code: o.code, email, firstName: o.firstName });
        await this.logSend(o.id, o.code, cfg.channelId, email, res.ok ? 'sent' : 'failed', res.ok ? 'manual' : (res.reason || 'send failed'), reviewUrl);
        if (!res.ok && !force) await this.releaseClaim(Number(o.id));
        this.invalidatePending();
        return res;
    }

    // ── Stats + log for the admin ───────────────────────────────────────
    async stats(days = 30): Promise<any> {
        const d = Math.max(1, Math.min(days, 365));
        const [totals] = await this.db.query(
            `SELECT SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent, SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS skipped, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
             FROM review_log WHERE createdAt > DATE_SUB(NOW(), INTERVAL ? DAY)`, [d]);
        const daily = await this.db.query(
            `SELECT DATE(createdAt) AS day, SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent
             FROM review_log WHERE createdAt > DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY DATE(createdAt) ORDER BY day`, [d]);
        const [optouts] = await this.db.query(`SELECT COUNT(*) AS n FROM review_optout`);
        return { totals: totals || {}, daily, optOuts: Number(optouts?.n || 0) };
    }

    async log(status?: string, take = 100): Promise<any[]> {
        const where = status ? `WHERE status = ?` : '';
        return this.db.query(
            `SELECT * FROM review_log ${where} ORDER BY createdAt DESC LIMIT ${Math.min(take, 500)}`,
            status ? [status] : [],
        ).catch(() => []);
    }
}
