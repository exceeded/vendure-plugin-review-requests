import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Logger, ProcessContext } from '@vendure/core';
import { ReviewRequestService } from './review-request.service';
import { ReviewRequestPlugin, getOptions } from './plugin';

const loggerCtx = 'ReviewRequests';

@Injectable()
export class ReviewCrons {
    constructor(private service: ReviewRequestService, private processContext: ProcessContext) {}

    /** Hourly eligibility scan + send. Worker only; licensed installs only. */
    @Cron(CronExpression.EVERY_HOUR)
    async sendDueInvitations() {
        if (this.processContext.isServer) return;
        if (getOptions().disableCron) return;
        if (!ReviewRequestPlugin.isLicensed()) return;
        const results = await this.service.runAll(false);
        const sent = results.reduce((n, r) => n + (r.sent || 0), 0);
        if (sent > 0) {
            Logger.info(`Sent ${sent} review invitation(s) across ${results.length} channel(s)`, loggerCtx);
        }
    }
}
