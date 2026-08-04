import { describe, expect, it } from 'vitest';
import { buildReviewUrl, renderStars } from './trustpilot';
import { renderTemplate, wrapEmail } from './templates';

describe('buildReviewUrl', () => {
    it('substitutes the domain into the free evaluate URL', () => {
        expect(buildReviewUrl('https://www.trustpilot.com/evaluate/{domain}', 'elite-software.co.uk'))
            .toBe('https://www.trustpilot.com/evaluate/elite-software.co.uk');
    });
    it('strips scheme + path from a messy domain', () => {
        expect(buildReviewUrl('https://www.trustpilot.com/evaluate/{domain}', 'https://Shop.Example.com/path'))
            .toBe('https://www.trustpilot.com/evaluate/Shop.Example.com');
    });
    it('supports a custom (e.g. Google) template', () => {
        expect(buildReviewUrl('https://g.page/r/{domain}/review', 'mybiz'))
            .toBe('https://g.page/r/mybiz/review');
    });
    it('falls back to the default template when none given', () => {
        expect(buildReviewUrl('', 'x.com')).toBe('https://www.trustpilot.com/evaluate/x.com');
    });
});

describe('renderStars', () => {
    it('renders 5 star cells, N of them "on"', () => {
        const html = renderStars(4);
        expect((html.match(/★/g) || []).length).toBe(5);
        expect((html.match(/#00b67a/g) || []).length).toBe(4); // 4 green
        expect((html.match(/#dcdce6/g) || []).length).toBe(1); // 1 grey
    });
    it('clamps out-of-range values', () => {
        expect((renderStars(9).match(/#00b67a/g) || []).length).toBe(5);
        expect((renderStars(-2).match(/#00b67a/g) || []).length).toBe(0);
    });
});

describe('renderTemplate', () => {
    it('substitutes variables and drops unknowns', () => {
        expect(renderTemplate('Hi {{firstName}} — order {{orderCode}}{{nope}}', { firstName: 'Sam', orderCode: 'ABC' }))
            .toBe('Hi Sam — order ABC');
    });
});

describe('wrapEmail', () => {
    it('includes an unsubscribe link when a URL is provided', () => {
        expect(wrapEmail('<p>hi</p>', 'ELITE', 'https://x/optout')).toContain('Unsubscribe');
        expect(wrapEmail('<p>hi</p>', 'ELITE', '')).not.toContain('Unsubscribe');
    });
    it('escapes the business name in the footer', () => {
        expect(wrapEmail('<p>hi</p>', '<b>x</b>', '')).toContain('&lt;b&gt;x&lt;/b&gt;');
    });
});
