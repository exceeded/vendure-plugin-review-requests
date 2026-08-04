import { mergeConfig } from '@vendure/core';
import { createTestEnvironment, registerInitializer, MysqlInitializer, testConfig } from '@vendure/testing';
import { initialData } from '../../../e2e-shared/initial-data';
import { ReviewRequestPlugin } from '../src/plugin';
import { ReviewRequestService } from '../src/review-request.service';

/**
 * Review-requests targets MySQL/MariaDB (DATE_SUB/INTERVAL), so this runs
 * against real MariaDB — skipped unless creds are provided via env:
 *   RR_E2E_DB_HOST RR_E2E_DB_PORT RR_E2E_DB_USER RR_E2E_DB_PASS
 */
const DB = process.env.RR_E2E_DB_HOST
    ? { host: process.env.RR_E2E_DB_HOST, port: Number(process.env.RR_E2E_DB_PORT || 3306),
        username: process.env.RR_E2E_DB_USER || 'root', password: process.env.RR_E2E_DB_PASS || '' }
    : null;

const PORT = 3064;
const BASE = `http://localhost:${PORT}`;
const run = DB ? describe : describe.skip;

run('@huloglobal/vendure-plugin-review-requests (MariaDB)', () => {
    registerInitializer('mysql', new MysqlInitializer());
    const config = mergeConfig(testConfig, {
        apiOptions: { port: PORT },
        dbConnectionOptions: {
            type: 'mysql' as const, host: DB!.host, port: DB!.port,
            username: DB!.username, password: DB!.password, database: 'hulo_rr_e2e', synchronize: true,
        },
        plugins: [ReviewRequestPlugin.init({ publicBaseUrl: BASE, optOutSecret: 'e2e-secret' })],
    });
    const { server } = createTestEnvironment(config);
    beforeAll(async () => { await server.init({ initialData, productsCsvPath: '', customerCount: 0 } as any); }, 120_000);
    afterAll(async () => { await server.destroy(); });
    const svc = () => (server as any).app.get(ReviewRequestService) as ReviewRequestService;

    it('admin endpoints reject anonymous callers', async () => {
        for (const p of ['config', 'stats', 'log', 'template', 'exclusions', 'meta']) {
            expect([401, 403]).toContain((await fetch(`${BASE}/review-requests/${p}`)).status);
        }
    });

    it('saves + reads per-channel config', async () => {
        const cfgs = await svc().getAllConfigs();
        expect(cfgs.length).toBeGreaterThan(0);
        await svc().saveConfig({ ...cfgs[0], enabled: true, delayDays: 21, triggerState: 'Delivered', trustpilotDomain: 'elite-software.co.uk', businessName: 'ELITE' } as any);
        const back = await svc().getConfig(cfgs[0].channelId);
        expect(back.enabled).toBe(true);
        expect(back.delayDays).toBe(21);
        expect(back.businessName).toBe('ELITE');
    });

    it('excludes emails + domains, and reflects it in isExcluded', async () => {
        await svc().addExclusion('email', 'blocked@example.com', 'e2e');
        await svc().addExclusion('email_domain', 'wholesale.test', 'e2e');
        expect(await svc().isExcluded('blocked@example.com')).toBe(true);
        expect(await svc().isExcluded('anyone@wholesale.test')).toBe(true);
        expect(await svc().isExcluded('normal@gmail.com')).toBe(false);
    });

    it('opt-out requires a valid signed token, then excludes', async () => {
        const svc0 = svc();
        const email = 'optme@example.com';
        expect(await svc0.optOut(email, 'wrong-token')).toBe(false);
        const goodToken = svc0.optOutToken(email);
        expect(await svc0.optOut(email, goodToken)).toBe(true);
        expect(await svc0.isExcluded(email)).toBe(true);
    });

    it('the public opt-out page renders (valid + invalid token)', async () => {
        const email = 'pageme@example.com';
        const tok = svc().optOutToken(email);
        const good = await (await fetch(`${BASE}/review-requests/optout?e=${encodeURIComponent(email)}&t=${tok}`)).text();
        expect(good).toContain('unsubscribed');
        const bad = await (await fetch(`${BASE}/review-requests/optout?e=x@y.com&t=nope`)).text();
        expect(bad).toContain('expired');
    });

    it('composes an invitation email with the review link', async () => {
        const cfg = await svc().getConfig(1);
        const composed = await svc().composeEmail(cfg, 'shopper@example.com', 'Sam', 'ORD123');
        expect(composed).toBeTruthy();
        expect(composed!.html).toContain('trustpilot.com/evaluate/elite-software.co.uk');
        expect(composed!.subject).toContain('Sam');
    });

    it('dry-run eligibility returns a numeric summary (no orders in the fixture)', async () => {
        const cfg = await svc().getConfig(1);
        const res = await svc().runChannel(cfg, true);
        expect(res).toHaveProperty('eligible');
        expect(res.sent).toBe(0);
    });

    it('template edit + reset round-trips', async () => {
        await svc().saveTemplate(1, 'Custom {{firstName}}', '<p>{{reviewUrl}}</p>');
        expect((await svc().getTemplate(1)).isDefault).toBe(false);
        await svc().resetTemplate(1);
        expect((await svc().getTemplate(1)).isDefault).toBe(true);
    });
});
