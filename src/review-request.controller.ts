import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Ctx, Permission, RequestContext } from '@vendure/core';

import { ReviewRequestService } from './review-request.service';
import { ReviewRequestPlugin } from './plugin';
import { ReviewChannelConfig } from './types';
import { renderTemplate, wrapEmail } from './templates';
import { buildReviewUrl, renderStars } from './trustpilot';
import { performSelfUpdate, selfUpdateEnv, evalInstanceId, describeLicence, RateLimiter } from '@huloglobal/vendure-licence-sdk';

function denyUnlessAdmin(ctx: RequestContext, res: Response, write: boolean | 'superadmin'): boolean {
    const needed = write === 'superadmin' ? [Permission.SuperAdmin] : write ? [Permission.UpdateSettings] : [Permission.ReadSettings];
    if (!ctx.userHasPermissions(needed)) { res.status(403).json({ error: 'forbidden' }); return true; }
    return false;
}

@Controller('review-requests')
export class ReviewRequestController {
    constructor(private service: ReviewRequestService) {}

    // ── Public: one-click unsubscribe (signed) ─────────────────────────
    /** GET only shows a confirm button: link scanners and mail clients prefetch GETs and used to unsubscribe people silently. */
    @Get('optout')
    async optoutPage(@Req() req: Request, @Res() res: Response, @Query('e') e?: string, @Query('t') t?: string) {
        if (this.limited(req, res)) return;
        const valid = await this.service.optOutTokenValid(String(e || ''), String(t || ''));
        res.setHeader('cache-control', 'no-store');
        if (!valid) return res.status(400).type('html').send(this.optoutHtml(false, 'Link expired', 'This unsubscribe link is invalid or has expired. If you keep getting emails, just reply to one and we\'ll remove you.'));
        const action = `/review-requests/optout?e=${encodeURIComponent(String(e || ''))}&t=${encodeURIComponent(String(t || ''))}`;
        return res.type('html').send(this.optoutHtml(true, 'Unsubscribe from review requests?', `<form method="post" action="${action}"><button type="submit" style="background:#0f172a;color:#fff;border:0;border-radius:8px;padding:12px 22px;font-size:15px;cursor:pointer">Yes, unsubscribe me</button></form>`));
    }

    /** RFC 8058 one-click (mail clients POST here) and the confirm button above. */
    @Post('optout')
    async optout(@Req() req: Request, @Res() res: Response, @Query('e') e?: string, @Query('t') t?: string) {
        if (this.limited(req, res)) return;
        const ok = await this.service.optOut(String(e || ''), String(t || ''));
        res.setHeader('cache-control', 'no-store');
        res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<div style="font-family:Arial,sans-serif;max-width:520px;margin:60px auto;padding:24px;text-align:center;color:#0f172a">
<h1 style="font-size:22px">${ok ? 'You\'re unsubscribed' : 'Link expired'}</h1>
<p style="color:#475569;line-height:1.6">${ok
    ? 'You won\'t receive any more review requests from us. Thanks — and sorry for the interruption.'
    : 'This unsubscribe link is invalid or has expired. If you keep getting emails, just reply to one and we\'ll remove you.'}</p>
</div>`);
    }

    private optoutHtml(ok: boolean, title: string, body: string): string {
        return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<div style="font-family:Arial,sans-serif;max-width:520px;margin:60px auto;padding:24px;text-align:center;color:#0f172a">
<h1 style="font-size:22px">${title}</h1><div style="color:#475569;line-height:1.6">${body}</div></div>`;
    }

    private static limiter = new RateLimiter({ capacity: 30, windowMs: 60_000 });
    private limited(req: Request, res: Response): boolean {
        const ip = String(req.ip || '');
        if (ip && !ReviewRequestController.limiter.allow(`optout|${ip}`)) { res.status(429).type('text').send('Too many requests'); return true; }
        return false;
    }

    // ── Admin: meta / licence ──────────────────────────────────────────
    @Get('meta')
    async meta(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        const updater = ReviewRequestPlugin.getUpdateChecker();
        const licence = ReviewRequestPlugin.getLicenceStatus();
        return res.json({
            name: ReviewRequestPlugin.getPackageName(),
            version: ReviewRequestPlugin.getPackageVersion(),
            update: updater ? updater.getStatus() : null,
            selfUpdate: selfUpdateEnv(),
            licensed: !!licence?.valid,
            licence: describeLicence(licence),
            licenceMessage: licence?.valid ? '' : (licence?.message || 'No licence key configured'),
            tier: licence?.valid ? 'paid' : (ReviewRequestPlugin.getEvalState()?.active ? 'trial' : 'free'),
            eval: ReviewRequestPlugin.getEvalState(),
        });
    }

    /** Review panel on the admin order-detail page. */
    @Get('order-status/:orderId')
    async orderStatus(@Ctx() ctx: RequestContext, @Res() res: Response, @Param('orderId') orderId: string) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        const id = Number(orderId);
        if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'bad-order-id' });
        return res.json(await this.service.orderReviewStatus(id));
    }

    /** Manually send (or force-resend) the review invitation for one order. */
    @Post('send-order/:orderId')
    async sendOrder(@Ctx() ctx: RequestContext, @Res() res: Response, @Param('orderId') orderId: string, @Body() body: any) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        if (!ReviewRequestPlugin.hasPremiumAccess()) {
            return res.status(402).json({ error: 'licence_required', message: 'Sending review requests requires a licence (or an active evaluation).' });
        }
        const id = Number(orderId);
        if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'bad-order-id' });
        const result = await this.service.sendForOrder(id, !!body?.force);
        return res.status(result.ok ? 200 : 400).json(result);
    }

    /** One-click in-app update (owner-approved feature): installs a
     *  registry-verified version of THIS plugin via the host's package
     *  manager and restarts under the process supervisor. Admin-only;
     *  package name is hard-coded; HULO_SELF_UPDATE=off disables. */
    @Post('update/run')
    async updateRun(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (denyUnlessAdmin(ctx, res, 'superadmin')) return;
        const updater = ReviewRequestPlugin.getUpdateChecker();
        const target = String(body?.version || updater?.getStatus()?.latest || '').trim();
        if (target && !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(target)) return res.status(400).json({ ok: false, message: 'Not a valid version.' });
        if (!target) return res.status(400).json({ ok: false, message: 'No target version known yet — the registry check runs daily; try again shortly.' });
        const result = await performSelfUpdate({ packageName: ReviewRequestPlugin.getPackageName(), targetVersion: target });
        return res.status(result.ok ? 200 : 400).json(result);
    }

    /** Admin-UI licence activation: paste the key from the purchase
     *  email, verified with exactly the boot-time checks, applied
     *  immediately (no .env edit, no redeploy) and persisted. */
    @Post('licence/activate')
    async licenceActivate(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        const key = String(body?.key || '').trim();
        if (!key) return res.status(400).json({ licensed: false, message: 'Paste your licence key first.' });
        const status = ReviewRequestPlugin.activateRuntimeLicence(key);
        if (!status.valid) return res.status(400).json({ licensed: false, message: status.message || 'Invalid licence key.' });
        await this.service.saveStoredLicenceKey(key);
        return res.json({ licensed: true, message: status.message });
    }

    /** Remove an admin-activated key (env-configured keys are unaffected). */
    @Post('licence/deactivate')
    async licenceDeactivate(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        await this.service.clearStoredLicenceKey();
        ReviewRequestPlugin.deactivateRuntimeLicence();
        return res.json({ licensed: false });
    }

    /** Buy-from-admin: mint a claim token and return the HULO buy-page
     *  URL. Once checkout completes the licence server binds the claim to
     *  the minted key and `licence/claim-status` installs it — no email
     *  round-trip, no .env edit, no restart. */
    @Post('licence/purchase-link')
    async licencePurchaseLink(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        const plan = (['monthly', 'annual', 'lifetime'].includes(String(body?.plan)) ? String(body.plan) : 'annual') as 'monthly' | 'annual' | 'lifetime';
        try {
            const r = await this.purchaseClaimClient().createPurchaseLink(plan, String(body?.email || '').trim() || undefined);
            return res.json({ url: r.url, state: 'pending' });
        } catch (e: any) {
            return res.status(500).json({ message: e?.message || 'Could not start the purchase — try again shortly.' });
        }
    }

    /** Poll target for the admin page while a purchase is pending; with
     *  `?check=1` it asks the licence server right now and installs the
     *  key if it is ready. Installed claims are re-checked daily so a
     *  renewed subscription key lands automatically too. */
    @Get('licence/claim-status')
    async licenceClaimStatus(@Ctx() ctx: RequestContext, @Res() res: Response, @Query('check') check?: string) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        const client = this.purchaseClaimClient();
        const st = check ? await client.checkNow() : await client.status();
        return res.json({ ...st, licensed: ReviewRequestPlugin.isLicensed() });
    }

    /** Stripe billing portal (update card, cancel, switch plan) for the
     *  subscription behind this install's licence. Ownership is proven by
     *  the buy-from-admin claim or by the stored licence key itself. */
    @Post('licence/portal-link')
    async licencePortalLink(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        let storedKey: string | null = null;
        try { storedKey = await this.service.loadStoredLicenceKey(); } catch { storedKey = null; }
        const url = await this.purchaseClaimClient().billingPortalUrl(storedKey);
        if (!url) return res.status(404).json({ message: 'No billing portal is available for this licence (lifetime and master licences have nothing to manage; for a key set via the environment, reply to your receipt email for a portal link).' });
        return res.json({ url });
    }

    /** Buy-from-admin auto-install client (hooks live here so the service
     *  never has to import the plugin class). */
    private purchaseClaimClient() {
        return this.service.initPurchaseClaim({
            packageName: ReviewRequestPlugin.getPackageName(),
            instanceId: () => evalInstanceId(),
            onLicence: async (key: string) => {
                const status = ReviewRequestPlugin.activateRuntimeLicence(key);
                if (!status.valid) return false;
                await this.service.saveStoredLicenceKey(key);
                return true;
            },
        });
    }

    async onApplicationBootstrap() {
        await this.purchaseClaimClient().resume().catch(() => undefined);
    }

    /** Admin opt-in: "email me before my evaluation ends". Proxied
     *  server-to-server to the HULO licence server, which sends a
     *  welcome email and runs the reminder drip. Explicit consent only —
     *  nothing is sent anywhere unless the admin submits an address. */
    @Post('eval/remind-me')
    async evalRemindMe(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        const email = String(body?.email || '').trim().slice(0, 320);
        const instanceId = ReviewRequestPlugin.getEvalInstanceId();
        if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email) || !instanceId) return res.status(400).json({ error: 'bad-request' });
        try {
            const base = (process.env.HULO_LICENCE_EVAL_URL || 'https://elite.charity/licence/eval/register').replace(/\/register$/, '');
            const resp = await fetch(`${base}/lead`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ plugin: ReviewRequestPlugin.getPackageName(), instanceId, email }),
                signal: AbortSignal.timeout(8_000),
            });
            if (!resp.ok) return res.status(502).json({ error: 'upstream', status: resp.status });
            return res.json({ ok: true });
        } catch {
            return res.status(502).json({ error: 'unreachable' });
        }
    }

    // ── Admin: config ──────────────────────────────────────────────────
    @Get('config')
    async getConfig(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        return res.json(await this.service.getAllConfigs());
    }
    @Post('config')
    async saveConfig(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: { configs: ReviewChannelConfig[] }) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        const known = new Set((await this.service.getAllConfigs()).map((c: any) => Number(c.channelId)));
        const int = (v: any, min: number, max: number, dflt: number) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };
        const str = (v: any, max: number) => String(v ?? '').slice(0, max);
        let saved = 0;
        const rejected: number[] = [];
        for (const raw of (Array.isArray(body?.configs) ? body.configs : []).slice(0, 50)) {
            const channelId = Number(raw?.channelId);
            if (!known.has(channelId)) { rejected.push(channelId); continue; }
            const c: ReviewChannelConfig = {
                ...raw, channelId,
                enabled: !!raw.enabled,
                triggerState: (['Delivered', 'PaymentSettled', 'Shipped'].includes(raw.triggerState) ? raw.triggerState : 'Delivered'),
                delayDays: int(raw.delayDays, 0, 365, 14), cooldownDays: int(raw.cooldownDays, 0, 3650, 120),
                maxPerRun: int(raw.maxPerRun, 1, 2000, 200), minOrderValuePence: int(raw.minOrderValuePence, 0, 1_000_000_000, 0),
                trustpilotDomain: str(raw.trustpilotDomain, 190), reviewUrlTemplate: str(raw.reviewUrlTemplate, 400), trustpilotApiKey: str(raw.trustpilotApiKey, 190),
                trustpilotBusinessUnitId: str(raw.trustpilotBusinessUnitId, 64), businessName: str(raw.businessName, 190), replyTo: str(raw.replyTo, 190),
                reviewMode: (['service', 'product', 'both'].includes(raw.reviewMode) ? raw.reviewMode : 'service'), productReviewUrlTemplate: str(raw.productReviewUrlTemplate, 400),
            };
            await this.service.saveConfig(c); saved++;
        }
        return res.json({ ok: true, saved, rejected });
    }

    // ── Admin: Trustpilot rating check (used by the settings tab) ───────
    @Post('trustpilot/check')
    async tpCheck(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: ReviewChannelConfig) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        const rating = await this.service.getRating(body as ReviewChannelConfig);
        return res.json({ ok: !!rating, rating, reviewUrl: buildReviewUrl(body.reviewUrlTemplate, body.trustpilotDomain) });
    }

    @Post('trustpilot/detect')
    async tpDetect(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: { trustpilotDomain: string; trustpilotApiKey: string; reviewUrlTemplate?: string }) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        return res.json(await this.service.detect(body.trustpilotDomain || '', body.trustpilotApiKey || '', body.reviewUrlTemplate));
    }

    // ── Admin: stats + activity ────────────────────────────────────────
    @Get('stats')
    async stats(@Ctx() ctx: RequestContext, @Res() res: Response, @Query('days') days?: string) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        const stats = await this.service.stats(Number(days || 30));
        const pending = await this.service.runAll(true).catch(() => []);
        return res.json({ ...stats, pending });
    }
    @Get('log')
    async log(@Ctx() ctx: RequestContext, @Res() res: Response, @Query('status') status?: string) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        return res.json(await this.service.log(status || undefined));
    }

    // ── Admin: run now (manual trigger) ────────────────────────────────
    @Post('run')
    async run(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        if (!ReviewRequestPlugin.hasPremiumAccess()) {
            return res.status(402).json({ error: 'licence_required', message: 'Your evaluation has ended — sending review requests now requires a licence.' });
        }
        return res.json({ ok: true, results: await this.service.runAll(false) });
    }

    // ── Admin: templates ───────────────────────────────────────────────
    @Get('template')
    async getTemplate(@Ctx() ctx: RequestContext, @Res() res: Response, @Query('channelId') channelId?: string) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        return res.json(await this.service.getTemplate(Number(channelId || 1)));
    }
    @Post('template')
    async saveTemplate(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: { channelId: number; subject: string; body: string; reset?: boolean }) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        if (body.reset) await this.service.resetTemplate(Number(body.channelId));
        else await this.service.saveTemplate(Number(body.channelId), body.subject || '', body.body || '');
        return res.json({ ok: true });
    }
    @Post('template/preview')
    async preview(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: { channelId: number; subject: string; body: string }) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        const cfg = await this.service.getConfig(Number(body.channelId || 1));
        const rating = await this.service.getRating(cfg);
        const businessName = cfg.businessName || cfg.trustpilotDomain || 'Your Store';
        const wantService = cfg.reviewMode === 'service' || cfg.reviewMode === 'both';
        const wantProduct = cfg.reviewMode === 'product' || cfg.reviewMode === 'both';
        const reviewUrl = buildReviewUrl(cfg.reviewUrlTemplate, cfg.trustpilotDomain);
        const ratingBlock = (wantService && rating)
            ? `<div style="text-align:center;margin:0 0 18px">${renderStars(rating.stars)}<div style="font-size:13px;color:#475569;margin-top:6px">Rated <strong>${rating.trustScore.toFixed(1)}</strong> by ${rating.numberOfReviews.toLocaleString()} customers on ${this.service.platformName(cfg)}</div></div>`
            : '';
        const reviewButton = wantService
            ? `<p style="margin:0 0 22px;text-align:center"><a href="${reviewUrl}" style="display:inline-block;background:#00b67a;color:#fff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:8px">★ Leave a review</a></p>`
            : '';
        let productList = '';
        if (wantProduct && cfg.productReviewUrlTemplate) {
            const sample = [{ name: 'Sample Product A', slug: 'sample-a' }, { name: 'Sample Product B', slug: 'sample-b' }];
            productList = (this.service as any).renderProductList(sample, cfg.productReviewUrlTemplate, 'DEMO12345678');
        }
        const vars = { firstName: 'Sam', orderCode: 'DEMO12345678', businessName, reviewUrl, ratingBlock, reviewButton, productList, unsubscribeUrl: '#' };
        return res.json({
            subject: renderTemplate(body.subject || '', vars),
            html: wrapEmail(renderTemplate(body.body || '', vars), businessName, '#'),
        });
    }

    // ── Admin: send a test to yourself ─────────────────────────────────
    @Post('test-send')
    async testSend(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: { channelId: number; email: string }) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        if (!body?.email) return res.status(400).json({ error: 'email required' });
        const cfg = await this.service.getConfig(Number(body.channelId || 1));
        const result = await this.service.sendInvitation(cfg, { id: 0, code: 'TEST-1234', email: body.email, firstName: 'there' });
        return res.status(result.ok ? 200 : 500).json(result);
    }

    // ── Admin: customer search + exclusion check ───────────────────────
    @Get('customers/search')
    async searchCustomers(@Ctx() ctx: RequestContext, @Res() res: Response, @Query('q') q?: string) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        return res.json(await this.service.searchCustomers(q || ''));
    }
    @Get('exclusions/check')
    async checkExclusion(@Ctx() ctx: RequestContext, @Res() res: Response, @Query('email') email?: string) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        return res.json(await this.service.checkExcluded(email || ''));
    }

    // ── Admin: exclusions ──────────────────────────────────────────────
    @Get('exclusions')
    async exclusions(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        return res.json(await this.service.listExclusions());
    }
    @Post('exclusions')
    async addExclusion(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: { type: string; value: string; note?: string }) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        await this.service.addExclusion(body.type, body.value, body.note);
        return res.json({ ok: true });
    }
    @Delete('exclusions/:id')
    async removeExclusion(@Ctx() ctx: RequestContext, @Res() res: Response, @Param('id') id: string) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        await this.service.removeExclusion(Number(id));
        return res.json({ ok: true });
    }
}
