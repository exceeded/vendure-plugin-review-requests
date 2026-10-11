import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { SharedModule } from '@vendure/admin-ui/core';

interface WidgetData {
    tier: 'paid' | 'trial' | 'free';
    notice: { kind: string; message: string; daysLeft: number } | null;
    stats: Array<{ label: string; value: string }>;
    route: string;
}

/**
 * Dashboard widget: three headline figures for the last 7 days, the
 * licence-lifecycle notice when one applies, and a link to the plugin page.
 * Same relative-URL HttpClient calls as the main page (admin auth applies).
 */
@Component({
    selector: 'hulo-review-requests-widget',
    standalone: true,
    imports: [SharedModule],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="rr-widget">
            <div class="rr-figures" *ngIf="data; else loading">
                <div class="rr-figure" *ngFor="let s of data.stats">
                    <div class="rr-num">{{ s.value }}</div>
                    <div class="rr-label">{{ s.label }}</div>
                </div>
            </div>
            <ng-template #loading><p class="rr-muted">{{ error || 'Loading…' }}</p></ng-template>
            <p class="rr-period" *ngIf="data">Last 7 days<span *ngIf="data.tier !== 'paid'"> · {{ data.tier === 'trial' ? 'evaluation' : 'free tier' }}</span></p>
            <div class="rr-notice" *ngIf="data?.notice">{{ data!.notice!.message }}</div>
            <a class="rr-open" [routerLink]="data?.route || '/extensions/review-requests'">Open Review Requests →</a>
        </div>
    `,
    styles: [`
        .rr-widget { display:flex; flex-direction:column; gap:10px; padding:4px 2px; }
        .rr-figures { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; }
        .rr-figure { padding:12px 14px; border-radius:10px; background:var(--color-component-bg-200,#f2f3f5); border:1px solid var(--color-component-border-200,#d5d8de); }
        .rr-num { font-size:26px; font-weight:700; font-variant-numeric:tabular-nums; color:var(--color-text-100,#1f2937); }
        .rr-label { margin-top:2px; font-size:11px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--color-text-300,#5d6470); }
        .rr-period, .rr-muted { margin:0; font-size:12px; color:var(--color-text-300,#5d6470); }
        .rr-notice { padding:8px 12px; border-radius:8px; font-size:12.5px; background:#fffbeb; border:1px solid #fcd34d; color:#92400e; }
        .rr-open { font-size:13px; font-weight:600; text-decoration:none; }
    `],
})
export class ReviewRequestsWidgetComponent implements OnInit {
    data: WidgetData | null = null;
    error = '';

    constructor(private http: HttpClient, private cdr: ChangeDetectorRef) {}

    ngOnInit() {
        this.http.get<WidgetData>('/review-requests/widget').subscribe({
            next: d => { this.data = d; this.cdr.markForCheck(); },
            error: () => { this.error = 'Could not load Review Requests figures.'; this.cdr.markForCheck(); },
        });
    }
}
