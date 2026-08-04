/**
 * Shared types for @huloglobal/vendure-plugin-review-requests.
 */

/** Which order milestone starts the delay clock. */
export type TriggerState = 'Delivered' | 'PaymentSettled' | 'Shipped';

export interface ReviewChannelConfig {
    channelId: number;
    channelCode?: string;
    enabled: boolean;
    /** Order state the order must have reached to be eligible. */
    triggerState: TriggerState;
    /** Send the invitation this many days after the order was placed. */
    delayDays: number;
    /** Skip orders below this value (pence). 0 = no minimum. */
    minOrderValuePence: number;
    /** Never invite the same customer more often than this (days). 0 = no cooldown. */
    cooldownDays: number;
    /** Trustpilot business domain, e.g. "elite-software.co.uk" — used to build
     *  the free review link and to look up the live rating. */
    trustpilotDomain: string;
    /** Review-link template. {domain} is substituted. Default is the free
     *  Trustpilot evaluate page; can point at Google or any URL instead. */
    reviewUrlTemplate: string;
    /** Optional free Trustpilot API key + business-unit id, used only to READ
     *  the live star rating / review count for the email (no paid features). */
    trustpilotApiKey: string;
    trustpilotBusinessUnitId: string;
    /** Display name used in the email ("Join N customers who rated {businessName}"). */
    businessName: string;
    /** Optional Reply-To for the invitation email. */
    replyTo: string;
    /** Max invitations sent per cron run (safety throttle). */
    maxPerRun: number;
}

export const DEFAULT_CONFIG: Omit<ReviewChannelConfig, 'channelId' | 'channelCode'> = {
    enabled: false,
    triggerState: 'Delivered',
    delayDays: 14,
    minOrderValuePence: 0,
    cooldownDays: 120,
    trustpilotDomain: '',
    reviewUrlTemplate: 'https://www.trustpilot.com/evaluate/{domain}',
    trustpilotApiKey: '',
    trustpilotBusinessUnitId: '',
    businessName: '',
    replyTo: '',
    maxPerRun: 200,
};

export interface ReviewPluginOptions {
    /** Public host of the Vendure server, used for opt-out links + tracking. */
    publicBaseUrl?: string;
    /** SMTP transport. Falls back to SMTP_SERVER/SMTP_PORT/SMTP_USER/
     *  SMTP_PASSWORD/SMTP_FROM env vars when omitted. */
    smtp?: { host: string; port: number; user: string; pass: string; from: string };
    /** Secret used to sign opt-out links. Falls back to HULO_IP_SALT. */
    optOutSecret?: string;
    /** Disable the scheduled sender (e.g. for a read-only replica). */
    disableCron?: boolean;
    /** How the cron runs are logged / capped is per-channel (maxPerRun). */
}

export type LogStatus = 'sent' | 'failed' | 'skipped';
