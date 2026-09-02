import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Ctx, Permission, RequestContext } from '@vendure/core';

import { ReviewRequestService } from './review-request.service';
import { ReviewRequestPlugin } from './plugin';
import { ReviewChannelConfig } from './types';
import { renderTemplate, wrapEmail } from './templates';
import { buildReviewUrl, renderStars } from './trustpilot';
import { performSelfUpdate, selfUpdateEnv, evalInstanceId, describeLicence } from '@huloglobal/vendure-licence-sdk';

function denyUnlessAdmin(ctx: RequestContext, res: Response, write: boolean): boolean {
    const needed = write ? [Permission.UpdateSettings] : [Permission.ReadSettings];
    if (!ctx.userHasPermissions(needed)) { res.status(403).json({ error: 'forbidden' }); return true; }
    return false;
}

@Controller('review-requests')
export class ReviewRequestController {
    constructor(private service: ReviewRequestService) {}

    // ── Public: one-click unsubscribe (signed) ─────────────────────────
    @Get('optout')
    async optout(@Req() req: Request, @Res() res: Response, @Query('e') e?: string, @Query('t') t?: string) {
        const ok = await this.service.optOut(String(e || ''), String(t || ''));
        res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<div style="font-family:Arial,sans-serif;max-width:520px;margin:60px auto;padding:24px;text-align:center;color:#0f172a">
<h1 style="font-size:22px">${ok ? 'You\'re unsubscribed' : 'Link expired'}</h1>
<p style="color:#475569;line-height:1.6">${ok
    ? 'You won\'t receive any more review requests from us. Thanks — and sorry for the interruption.'
    : 'This unsubscribe link is invalid or has expired. If you keep getting emails, just reply to one and we\'ll remove you.'}</p>
</div>`);
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
        if (denyUnlessAdmin(ctx, res, true)) return;
        const updater = ReviewRequestPlugin.getUpdateChecker();
        const target = String(body?.version || updater?.getStatus()?.latest || '').trim();
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
        const email = String(body?.email || '').trim();
        const instanceId = ReviewRequestPlugin.getEvalInstanceId();
        if (!email || !instanceId) return res.status(400).json({ error: 'bad-request' });
        try {
            const base = (process.env.HULO_LICENCE_EVAL_URL || 'https://elite.charity/licence/eval/register').replace(/\/register$/, '');
            const resp = await fetch(`${base}/lead`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ plugin: ReviewRequestPlugin.getPackageName(), instanceId, email }),
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
        let saved = 0;
        for (const c of body.configs || []) { await this.service.saveConfig(c); saved++; }
        return res.json({ ok: true, saved });
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
