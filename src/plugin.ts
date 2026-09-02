import { PluginCommonModule, Type, VendurePlugin } from '@vendure/core';
import {
    fingerprintPublicKey, Heartbeat, LicenceStatus, RevocationChecker, UpdateChecker,
    verifyLicence, warnIfIncompatibleVendure, EvaluationClient, EvaluationState,
} from '@huloglobal/vendure-licence-sdk';

import { ReviewRequestService } from './review-request.service';
import { ReviewRequestController } from './review-request.controller';
import { ReviewCrons } from './crons';
import { ReviewPluginOptions } from './types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PKG_VERSION: string = require('../package.json').version;
const PKG_NAME = '@huloglobal/vendure-plugin-review-requests';
const PLUGIN_ID = 'vendure-plugin-review-requests';

const HULO_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoLmNM5UljRqe71drM6lR
Ba5vXrLOcV3GAHkYvnVFQSqdE0avrge/jsD7WdA6x8qQFNRugxQcxDJa2l0+C+BH
SbU9TimGwhA1yusHHfuz9LAXks5IQ48+2e6Pulh7iThXPJUnIKqKZUN5HhL79aaK
vrZKIgSfVhwE5PMPXWZ+Ij5IRf74PLIUn1Er75qhBXlDJ4vF8y8/3owURNC1XiUB
DGElwV/LYNoqAQei4oixe4EAxPGvFi11pgHiGuRxuWckA88y6ZHLt6urfAY9sCkj
kF+2dc2yS3j7lD+SYAaV5LQYYjePP1CYvxCZ7HHRKqthHopxY1hsK2tBtni3f7/c
UwIDAQAB
-----END PUBLIC KEY-----`;

const REVOCATION_URL = process.env.HULO_LICENCE_REVOCATION_URL || 'https://elite.charity/licence/revoked.json';

export interface ReviewPluginInitOptions extends ReviewPluginOptions {
    /** JWT licence from huloglobal.com. Without it the plugin runs in the
     *  FREE tier: configure + preview + test-send only — scheduled sending
     *  requires a licence. */
    licenceKey?: string;
}

let cachedOptions: ReviewPluginInitOptions = {};
export function getOptions(): ReviewPluginInitOptions { return cachedOptions; }

/**
 * `@huloglobal/vendure-plugin-review-requests`
 *
 * Automated post-purchase review invitations, timed off order dates.
 * Branded, Trustpilot-style emails that link to your free Trustpilot
 * review page (no paid Automatic Feedback Service), with per-channel
 * timing, customer exclusions, cooldown + dedup, one-click opt-out and
 * a live star rating pulled from the free Trustpilot API.
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    controllers: [ReviewRequestController],
    providers: [ReviewRequestService, ReviewCrons],
    compatibility: '^3.0.0',
})
export class ReviewRequestPlugin {
    private static revocation: RevocationChecker | null = null;
    private static updateChecker: UpdateChecker | null = null;
    private static heartbeat: Heartbeat | null = null;
    private static licenceStatus: LicenceStatus | null = null;
    private static evalClient: EvaluationClient | null = null;

    static getUpdateChecker() { return ReviewRequestPlugin.updateChecker; }
    static getPackageVersion() { return PKG_VERSION; }
    static getPackageName() { return PKG_NAME; }
    static getLicenceStatus() { return ReviewRequestPlugin.licenceStatus; }
    static isLicensed(): boolean { return !!ReviewRequestPlugin.licenceStatus?.valid; }
    static getEvalState(): EvaluationState | null { return ReviewRequestPlugin.evalClient?.getState() ?? null; }
    static getEvalInstanceId(): string | null { return ReviewRequestPlugin.evalClient?.getInstanceId() ?? null; }
    /** Licensed installs AND installs inside the 14-day server-anchored
     *  evaluation window get the full feature set. */
    static hasPremiumAccess(): boolean {
        if (ReviewRequestPlugin.licenceStatus?.valid) return true;
        const ev = ReviewRequestPlugin.evalClient?.getState();
        return !!ev?.active;
    }

    private static licenceHost = '';

    /** Verify + apply a licence key at runtime (admin-UI activation).
     *  Identical checks to boot-time verification: signature, pluginId,
     *  domain binding, expiry, revocation list. Only applied when valid. */
    static activateRuntimeLicence(key: string): LicenceStatus {
        const status = verifyLicence({
            licenceKey: key, pluginId: PLUGIN_ID, host: ReviewRequestPlugin.licenceHost,
            publicKey: HULO_PUBLIC_KEY, revokedIds: ReviewRequestPlugin.revocation?.getRevokedIds(),
        });
        if (status.valid) {
            ReviewRequestPlugin.licenceStatus = status;
            ReviewRequestPlugin.evalClient?.stop();
        }
        return status;
    }

    /** Drop an admin-activated key at runtime: back to unlicensed state
     *  (an env/init key, if any, is re-verified by the caller flow) and
     *  the evaluation clock resumes from wherever the server says it is. */
    static deactivateRuntimeLicence(): void {
        ReviewRequestPlugin.licenceStatus = {
            valid: false,
            message: 'No licence key configured. The plugin will run in unlicensed (degraded) mode.',
        } as LicenceStatus;
        if (ReviewRequestPlugin.evalClient) {
            ReviewRequestPlugin.evalClient.start();
        } else {
            ReviewRequestPlugin.evalClient = new EvaluationClient({ packageName: PKG_NAME, packageVersion: PKG_VERSION });
            ReviewRequestPlugin.evalClient.start();
        }
    }

    constructor(private service: ReviewRequestService) {
        this.service.setOptions(cachedOptions);
        // Anonymous aggregates for the (opt-in) evaluation reminder emails —
        // "you sent N invitations during your trial" converts far better
        // than generic copy. Numbers only, never personal data.
        ReviewRequestPlugin.evalClient?.setStatsProvider(() => this.service.evalStats());
    }

    /** Apply an admin-activated licence key persisted in the DB. Runs
     *  after DI is up; an explicitly configured env/init key wins. */
    async onApplicationBootstrap() {
        if (ReviewRequestPlugin.isLicensed()) return;
        const stored = await this.service.loadStoredLicenceKey();
        if (stored) {
            const st = ReviewRequestPlugin.activateRuntimeLicence(stored);
            // eslint-disable-next-line no-console
            if (st.valid) console.log(`[${PKG_NAME}] licence restored from admin activation — ${st.message}`);
        }
    }

    static init(options: ReviewPluginInitOptions = {}): Type<ReviewRequestPlugin> {
        cachedOptions = options;
        warnIfIncompatibleVendure({ pluginPackageName: PKG_NAME, pluginPackageVersion: PKG_VERSION, supportedRange: { min: '3.5.0', max: '4.0.0' } });

        if (!ReviewRequestPlugin.revocation) { ReviewRequestPlugin.revocation = new RevocationChecker(REVOCATION_URL); ReviewRequestPlugin.revocation.start(); }
        if (!ReviewRequestPlugin.updateChecker) { ReviewRequestPlugin.updateChecker = new UpdateChecker(PKG_NAME, PKG_VERSION); ReviewRequestPlugin.updateChecker.start(); }

        const host = (options.publicBaseUrl || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        ReviewRequestPlugin.licenceHost = host;
        ReviewRequestPlugin.licenceStatus = verifyLicence({
            licenceKey: options.licenceKey, pluginId: PLUGIN_ID, host,
            publicKey: HULO_PUBLIC_KEY, revokedIds: ReviewRequestPlugin.revocation.getRevokedIds(),
        });
        if (!ReviewRequestPlugin.licenceStatus.valid) {
            // Unlicensed: register the install (no premium is granted by this; the 14-day
            // evaluation. All premium paths stay enabled while it runs;
            // when it ends the plugin drops to the free tier (configure,
            // preview + test-send only).
            if (!ReviewRequestPlugin.evalClient) {
                ReviewRequestPlugin.evalClient = new EvaluationClient({ packageName: PKG_NAME, packageVersion: PKG_VERSION });
                ReviewRequestPlugin.evalClient.start();
            }
            // eslint-disable-next-line no-console
            console.warn(`[${PKG_NAME}] ${ReviewRequestPlugin.licenceStatus.message} — running in the FREE tier — start the 14-day free trial (card required, nothing charged until day 15) from the plugin's admin page`);
        }
        if (!ReviewRequestPlugin.heartbeat) {
            ReviewRequestPlugin.heartbeat = new Heartbeat({
                packageName: PKG_NAME, packageVersion: PKG_VERSION,
                licenceKey: options.licenceKey, publicKeyFingerprint: fingerprintPublicKey(HULO_PUBLIC_KEY),
            });
            ReviewRequestPlugin.heartbeat.start();
        }
        return ReviewRequestPlugin;
    }

    static uiExtensions = {
        extensionPath: __dirname + '/../ui',
        ngModules: [
            { type: 'lazy' as const, route: 'review-requests', ngModuleFileName: 'review-requests.module.ts', ngModuleName: 'ReviewRequestsModule' },
            { type: 'shared' as const, ngModuleFileName: 'order-review-shared.module.ts', ngModuleName: 'OrderReviewSharedModule' },
        ],
    };
}
