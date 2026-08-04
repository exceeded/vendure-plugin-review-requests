import { Injectable, OnModuleInit } from '@nestjs/common';
import { Logger, TransactionalConnection } from '@vendure/core';
import { createHmac } from 'crypto';
import * as nodemailer from 'nodemailer';

import { DEFAULT_CONFIG, ReviewChannelConfig, ReviewPluginOptions, TriggerState } from './types';
import { DEFAULT_TEMPLATE, Template, renderTemplate, wrapEmail, escapeHtml } from './templates';
import { buildReviewUrl, fetchRating, findBusinessUnitId, renderStars, TrustpilotRating } from './trustpilot';
import { fetchGoogleRating } from './google';

const loggerCtx = 'ReviewRequests';

@Injectable()
export class ReviewRequestService implements OnModuleInit {
    private options: ReviewPluginOptions = {};
    setOptions(o: ReviewPluginOptions) { this.options = o; }
    getOptions() { return this.options; }

    constructor(private connection: TransactionalConnection) {}

    private get db() { return this.connection.rawConnection; }

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
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS review_template (
                channelId INT PRIMARY KEY,
                subject VARCHAR(255),
                body TEXT
            )`);
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
                INDEX idx_rl_created (createdAt)
            )`);
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
                trustpilotDomain, reviewUrlTemplate, trustpilotApiKey, trustpilotBusinessUnitId, businessName, replyTo, maxPerRun)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE enabled=VALUES(enabled), triggerState=VALUES(triggerState), delayDays=VALUES(delayDays),
                minOrderValuePence=VALUES(minOrderValuePence), cooldownDays=VALUES(cooldownDays),
                trustpilotDomain=VALUES(trustpilotDomain), reviewUrlTemplate=VALUES(reviewUrlTemplate),
                trustpilotApiKey=VALUES(trustpilotApiKey), trustpilotBusinessUnitId=VALUES(trustpilotBusinessUnitId),
                businessName=VALUES(businessName), replyTo=VALUES(replyTo), maxPerRun=VALUES(maxPerRun)`,
            [c.channelId, c.enabled ? 1 : 0, c.triggerState, c.delayDays, c.minOrderValuePence, c.cooldownDays,
             c.trustpilotDomain || '', c.reviewUrlTemplate || DEFAULT_CONFIG.reviewUrlTemplate, c.trustpilotApiKey || '',
             c.trustpilotBusinessUnitId || '', c.businessName || '', c.replyTo || '', c.maxPerRun || 200],
        );
    }

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
    }
    async removeExclusion(id: number): Promise<void> {
        await this.db.query(`DELETE FROM review_exclusion WHERE id = ?`, [id]);
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
            `SELECT id, firstName, lastName, emailAddress FROM customer
             WHERE deletedAt IS NULL
               AND (emailAddress LIKE ? OR firstName LIKE ? OR lastName LIKE ? OR CONCAT(firstName, ' ', lastName) LIKE ?)
             ORDER BY (LOWER(emailAddress) = ?) DESC, id DESC
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

    optOutToken(email: string): string {
        const secret = this.options.optOutSecret || process.env.HULO_IP_SALT || 'hulo-review-optout';
        return createHmac('sha256', secret).update(email.toLowerCase()).digest('hex').slice(0, 32);
    }
    optOutUrl(email: string): string {
        const base = (this.options.publicBaseUrl || '').replace(/\/$/, '');
        if (!base) return '';
        return `${base}/review-requests/optout?e=${encodeURIComponent(email)}&t=${this.optOutToken(email)}`;
    }
    async optOut(email: string, token: string): Promise<boolean> {
        const e = String(email || '').toLowerCase();
        if (!e || token !== this.optOutToken(e)) return false;
        await this.db.query(`INSERT IGNORE INTO review_optout (email, createdAt) VALUES (?, NOW())`, [e]);
        return true;
    }

    // ── Review rating (Trustpilot or Google, cached in memory 6h) ───────
    private ratingCache = new Map<string, { rating: TrustpilotRating | null; at: number }>();

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

    async getRating(cfg: ReviewChannelConfig): Promise<TrustpilotRating | null> {
        const platform = this.platformOf(cfg);
        if (!cfg.trustpilotApiKey || !cfg.trustpilotDomain) return null;
        const cacheKey = `${platform}|${cfg.trustpilotDomain}|${cfg.trustpilotBusinessUnitId}`;
        const hit = this.ratingCache.get(cacheKey);
        if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.rating;

        let rating: TrustpilotRating | null = null;
        if (platform === 'google') {
            // For Google the identifier field holds the Place ID.
            rating = await fetchGoogleRating(cfg.trustpilotDomain, cfg.trustpilotApiKey);
        } else if (platform === 'trustpilot') {
            let unitId = cfg.trustpilotBusinessUnitId;
            if (!unitId) unitId = (await findBusinessUnitId(cfg.trustpilotDomain, cfg.trustpilotApiKey)) || '';
            rating = unitId ? await fetchRating(unitId, cfg.trustpilotApiKey) : null;
        }
        this.ratingCache.set(cacheKey, { rating, at: Date.now() });
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
            : rating ? `Connected — ${rating.trustScore.toFixed(1)}★ from ${rating.numberOfReviews.toLocaleString()} reviews.`
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

    async composeEmail(cfg: ReviewChannelConfig, to: string, firstName: string, orderCode: string): Promise<{ subject: string; html: string } | null> {
        const tpl = await this.getTemplate(cfg.channelId);
        const reviewUrl = buildReviewUrl(cfg.reviewUrlTemplate, cfg.trustpilotDomain);
        const rating = await this.getRating(cfg);
        const businessName = cfg.businessName || cfg.trustpilotDomain || 'us';
        const ratingBlock = rating
            ? `<div style="text-align:center;margin:0 0 18px">${renderStars(rating.stars)}` +
              `<div style="font-size:13px;color:#475569;margin-top:6px">Rated <strong>${rating.trustScore.toFixed(1)}</strong> by ${rating.numberOfReviews.toLocaleString()} customers on ${this.platformName(cfg)}</div></div>`
            : '';
        const vars = {
            firstName: firstName || 'there', orderCode, businessName,
            reviewUrl, ratingBlock,
            unsubscribeUrl: this.optOutUrl(to),
        };
        const subject = renderTemplate(tpl.subject, vars);
        const bodyHtml = renderTemplate(tpl.body, vars);
        const html = wrapEmail(bodyHtml, businessName, this.optOutUrl(to));
        return { subject, html };
    }

    async sendInvitation(cfg: ReviewChannelConfig, order: { id: number; code: string; email: string; firstName: string }): Promise<{ ok: boolean; reason?: string }> {
        const smtp = this.smtp();
        if (!smtp) return { ok: false, reason: 'SMTP not configured' };
        const composed = await this.composeEmail(cfg, order.email, order.firstName, order.code);
        if (!composed) return { ok: false, reason: 'compose failed' };
        try {
            const transporter = nodemailer.createTransport({
                host: smtp.host, port: smtp.port, secure: smtp.port === 465,
                auth: { user: smtp.user, pass: smtp.pass },
            });
            await transporter.sendMail({
                from: cfg.businessName ? `"${cfg.businessName}" <${smtp.from}>` : smtp.from,
                to: order.email,
                replyTo: cfg.replyTo || undefined,
                subject: composed.subject,
                html: composed.html,
            });
            return { ok: true };
        } catch (e: any) {
            return { ok: false, reason: e.message };
        }
    }

    async logSend(orderId: number, orderCode: string, channelId: number, email: string, status: string, reason: string, reviewUrl: string) {
        await this.db.query(
            `INSERT INTO review_log (orderId, orderCode, channelId, email, status, reason, reviewUrl, createdAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
            [orderId, orderCode, channelId, email, status, reason || '', reviewUrl || ''],
        );
    }

    // ── Eligibility scan (the cron's engine) ────────────────────────────
    /**
     * Find orders placed ~delayDays ago that reached the trigger state, aren't
     * excluded / in cooldown / already invited, and send the invitation.
     * Returns a per-channel summary. `dryRun` computes eligibility without
     * sending (used for the Overview "pending" count and preview).
     */
    async runChannel(cfg: ReviewChannelConfig, dryRun = false): Promise<{ sent: number; skipped: number; failed: number; eligible: number }> {
        const out = { sent: 0, skipped: 0, failed: 0, eligible: 0 };
        if (!cfg.enabled && !dryRun) return out;

        // Candidate window: placed at least delayDays ago, but within a 3-day
        // lookback so we don't rescan ancient history. Dedup does the rest.
        const orders = await this.db.query(
            `SELECT o.id, o.code, o.state, o.subTotalWithTax, o.orderPlacedAt, c.emailAddress AS email, c.firstName
             FROM \`order\` o JOIN customer c ON c.id = o.customerId
             WHERE o.channelId = ?
               AND o.state = ?
               AND o.orderPlacedAt <= DATE_SUB(NOW(), INTERVAL ? DAY)
               AND o.orderPlacedAt >  DATE_SUB(NOW(), INTERVAL ? DAY)
               AND o.subTotalWithTax >= ?
               AND c.emailAddress IS NOT NULL AND c.emailAddress <> ''
             ORDER BY o.orderPlacedAt ASC
             LIMIT ?`,
            [cfg.channelId, cfg.triggerState, cfg.delayDays, cfg.delayDays + 3, cfg.minOrderValuePence, cfg.maxPerRun],
        ).catch((e: any) => { Logger.error(`candidate query failed: ${e.message}`, loggerCtx); return []; });

        for (const o of orders) {
            const email = String(o.email).toLowerCase();
            // already invited for this order?
            const [prior] = await this.db.query(`SELECT id FROM review_log WHERE orderId = ? AND status = 'sent' LIMIT 1`, [o.id]);
            if (prior) { continue; }
            // excluded / opted out?
            if (await this.isExcluded(email)) {
                if (!dryRun) await this.logSend(o.id, o.code, cfg.channelId, email, 'skipped', 'excluded', '');
                out.skipped++; continue;
            }
            // cooldown: invited (any order) within cooldownDays?
            if (cfg.cooldownDays > 0) {
                const [recent] = await this.db.query(
                    `SELECT id FROM review_log WHERE email = ? AND status = 'sent' AND createdAt > DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT 1`,
                    [email, cfg.cooldownDays],
                );
                if (recent) {
                    if (!dryRun) await this.logSend(o.id, o.code, cfg.channelId, email, 'skipped', 'cooldown', '');
                    out.skipped++; continue;
                }
            }
            out.eligible++;
            if (dryRun) continue;
            const reviewUrl = buildReviewUrl(cfg.reviewUrlTemplate, cfg.trustpilotDomain);
            const res = await this.sendInvitation(cfg, { id: o.id, code: o.code, email, firstName: o.firstName });
            if (res.ok) { await this.logSend(o.id, o.code, cfg.channelId, email, 'sent', '', reviewUrl); out.sent++; }
            else { await this.logSend(o.id, o.code, cfg.channelId, email, 'failed', res.reason || 'send failed', reviewUrl); out.failed++; }
        }
        return out;
    }

    async runAll(dryRun = false): Promise<any[]> {
        const configs = await this.getAllConfigs();
        const results = [];
        for (const cfg of configs) {
            if (!cfg.enabled) continue;
            results.push({ channelId: cfg.channelId, channelCode: cfg.channelCode, ...(await this.runChannel(cfg, dryRun)) });
        }
        return results;
    }

    // ── Stats + log for the admin ───────────────────────────────────────
    async stats(days = 30): Promise<any> {
        const d = Math.max(1, Math.min(days, 365));
        const [totals] = await this.db.query(
            `SELECT SUM(status='sent') AS sent, SUM(status='skipped') AS skipped, SUM(status='failed') AS failed
             FROM review_log WHERE createdAt > DATE_SUB(NOW(), INTERVAL ? DAY)`, [d]);
        const daily = await this.db.query(
            `SELECT DATE(createdAt) AS day, SUM(status='sent') AS sent
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
