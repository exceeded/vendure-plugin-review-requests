import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Ctx, Permission, RequestContext } from '@vendure/core';

import { ReviewRequestService } from './review-request.service';
import { ReviewRequestPlugin } from './plugin';
import { ReviewChannelConfig } from './types';
import { renderTemplate, wrapEmail } from './templates';
import { buildReviewUrl, renderStars } from './trustpilot';

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
            licensed: !!licence?.valid,
            licenceMessage: licence?.valid ? '' : (licence?.message || 'No licence key configured'),
            tier: licence?.valid ? 'paid' : (ReviewRequestPlugin.getEvalState()?.active ? 'trial' : 'free'),
            eval: ReviewRequestPlugin.getEvalState(),
        });
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
