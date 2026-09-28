import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Logger, ProcessContext } from '@vendure/core';
import { ReviewRequestService } from './review-request.service';
import { ReviewRequestPlugin, getOptions } from './plugin';

const loggerCtx = 'ReviewRequests';

@Injectable()
export class ReviewCrons {
    constructor(private service: ReviewRequestService, private processContext: ProcessContext) {}

    /** Concurrency guard: the schedule explorer has been observed invoking
     *  this handler twice in the same tick, and two overlapping scans could
     *  race past the per-order dedup and double-send. The flag flips
     *  synchronously before the first await, so a same-tick duplicate exits
     *  immediately. */
    private runInFlight = false;

    /** Hourly eligibility scan + send. Worker only; runs for licensed
     *  installs and installs inside the evaluation window. */
    @Cron(CronExpression.EVERY_HOUR)
    async sendDueInvitations() {
        if (this.processContext.isServer) return;
        if (getOptions().disableCron) return;
        // A key activated from the admin UI lives in the SERVER process; the worker
        // (which runs this cron) only saw the stored key at boot. Re-load it here.
        if (!ReviewRequestPlugin.isLicensed()) {
            try { const k = await this.service.loadStoredLicenceKey(); if (k) ReviewRequestPlugin.activateRuntimeLicence(k); } catch { /* store unavailable */ }
        }
        if (!ReviewRequestPlugin.hasPremiumAccess()) return;
        if (this.runInFlight) return;
        this.runInFlight = true;
        try {
            const results = await this.service.runAll(false);
            const sent = results.reduce((n, r) => n + (r.sent || 0), 0);
            if (sent > 0) {
                Logger.info(`Sent ${sent} review invitation(s) across ${results.length} channel(s)`, loggerCtx);
            }
        } catch (e: any) {
            Logger.error(`review invitation run failed: ${e?.message || e}`, loggerCtx);
        } finally {
            this.runInFlight = false;
        }
    }

    /** Monthly log housekeeping (worker only): skipped/failed audit rows older than
     *  18 months go, 5 000 at a time. 'sent' rows stay — dedup and cooldown read them. */
    @Cron(CronExpression.EVERY_1ST_DAY_OF_MONTH_AT_MIDNIGHT)
    async pruneLog() {
        if (this.processContext.isServer) return;
        if (getOptions().disableCron) return;
        try {
            const n = await this.service.pruneLog(18, 5000);
            if (n > 0) Logger.info(`Pruned ${n} review_log row(s) older than 18 months`, loggerCtx);
        } catch (e: any) {
            Logger.error(`review_log prune failed: ${e?.message || e}`, loggerCtx);
        }
    }
}
