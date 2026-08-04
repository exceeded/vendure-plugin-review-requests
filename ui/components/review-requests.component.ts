import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { NotificationService } from '@vendure/admin-ui/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

interface ReviewConfig {
    channelId: number; channelCode?: string; enabled: boolean;
    triggerState: 'Delivered' | 'PaymentSettled' | 'Shipped';
    delayDays: number; minOrderValuePence: number; cooldownDays: number;
    trustpilotDomain: string; reviewUrlTemplate: string;
    trustpilotApiKey: string; trustpilotBusinessUnitId: string;
    businessName: string; replyTo: string; maxPerRun: number;
    reviewMode: 'service' | 'product' | 'both'; productReviewUrlTemplate: string;
}
type Tab = 'overview' | 'settings' | 'email' | 'exclusions' | 'activity';

@Component({
    selector: 'ees-review-requests',
    standalone: false,
    template: `
        <vdr-page-block>
            <div class="hulo-hero">
                <div class="hulo-hero-logo" aria-hidden="true">
                    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
                        <rect width="64" height="64" rx="14" fill="#0f1419"/>
                        <rect x="13" y="20" width="38" height="26" rx="4" fill="none" stroke="#fff" stroke-width="2.4"/>
                        <path d="M14 22 L32 35 L50 22" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
                        <circle cx="46" cy="44" r="11" fill="#0f1419"/>
                        <path d="M46 35.5 l2.5 5.1 5.6 .8 -4.05 3.95 .95 5.55 -5.0 -2.63 -5.0 2.63 .95 -5.55 -4.05 -3.95 5.6 -.8 z" fill="#f59e0b"/>
                    </svg>
                </div>
                <div class="hulo-hero-text">
                    <h2 class="hulo-hero-title">Review requests</h2>
                    <p class="hulo-hero-sub">Automatically invite happy customers to review you on Trustpilot — timed off their order date, in your voice, using the free Trustpilot review page. No paid Automatic Feedback Service needed.</p>
                </div>
                <div class="hulo-hero-actions">
                    <button class="gbtn gbtn-hero" (click)="reloadAll()" [disabled]="loading"><clr-icon shape="refresh"></clr-icon> Refresh</button>
                </div>
            </div>
        </vdr-page-block>

        <vdr-page-block *ngIf="meta && !meta.licensed">
            <div class="update-banner major">
                <div><strong>🔓 Free tier</strong> — configure, preview and test-send are active. Scheduled sending needs a licence.</div>
                <div class="actions"><a href="https://huloglobal.com/vendure-plugins/review-requests/" target="_blank" class="gbtn gbtn-primary gbtn-sm">Get a licence ↗</a></div>
            </div>
        </vdr-page-block>

        <vdr-page-block *ngIf="!loading && current">
            <div class="card top-bar">
                <div class="card-block">
                    <div class="chan-row">
                        <label class="lbl">Channel</label>
                        <select class="form-select" [(ngModel)]="currentIdx" (ngModelChange)="onChannel()">
                            <option *ngFor="let c of configs; let i = index" [ngValue]="i">{{ c.channelCode }}</option>
                        </select>
                        <span class="gb-switch-group">
                            <button class="gb-switch" role="switch" [attr.aria-checked]="current.enabled" [class.on]="current.enabled" (click)="current.enabled = !current.enabled; markDirty()" aria-label="Enable review requests"><span class="gb-switch-knob" aria-hidden="true"></span></button>
                            <span class="gb-switch-label">{{ current.enabled ? 'Sending on' : 'Sending off' }}</span>
                        </span>
                        <span class="dirty-flag" *ngIf="dirty">● Unsaved</span>
                    </div>
                    <p class="status-sentence" [class.status-off]="!current.enabled">{{ statusSentence() }}</p>
                    <div class="tabs" role="tablist">
                        <button class="tab" role="tab" [class.active]="tab==='overview'" (click)="go('overview')">Overview</button>
                        <button class="tab" role="tab" [class.active]="tab==='settings'" (click)="go('settings')">Settings</button>
                        <button class="tab" role="tab" [class.active]="tab==='email'" (click)="go('email')">Email</button>
                        <button class="tab" role="tab" [class.active]="tab==='exclusions'" (click)="go('exclusions')">Exclusions<span class="tab-count" *ngIf="exclusions.length">{{ exclusions.length }}</span></button>
                        <button class="tab" role="tab" [class.active]="tab==='activity'" (click)="go('activity')">Activity</button>
                    </div>
                </div>
            </div>
        </vdr-page-block>

        <!-- OVERVIEW -->
        <ng-container *ngIf="!loading && current && tab==='overview'">
            <vdr-page-block>
                <div class="kpi-row">
                    <div class="kpi"><div class="kpi-label">Sent</div><div class="kpi-num">{{ stats?.totals?.sent || 0 }}</div><div class="kpi-sub">last 30 days</div></div>
                    <div class="kpi" [class.kpi-alert]="pendingTotal()>0"><div class="kpi-label">Eligible now</div><div class="kpi-num">{{ pendingTotal() }}</div><div class="kpi-sub">will send on next run</div></div>
                    <div class="kpi"><div class="kpi-label">Opt-outs</div><div class="kpi-num">{{ stats?.optOuts || 0 }}</div><div class="kpi-sub">all time</div></div>
                    <div class="kpi" [class.kpi-alert]="stats?.totals?.failed>0"><div class="kpi-label">Failed</div><div class="kpi-num">{{ stats?.totals?.failed || 0 }}</div><div class="kpi-sub">last 30 days</div></div>
                </div>
            </vdr-page-block>
            <vdr-page-block>
                <div class="card"><div class="card-block">
                    <div class="row-between"><h3 class="step-title" style="margin:0">Your review rating</h3>
                        <button class="gbtn gbtn-outline gbtn-sm" (click)="runNow()" [disabled]="running || (meta && !meta.licensed)">{{ running ? 'Sending…' : 'Send due now' }}</button></div>
                    <div *ngIf="rating" class="rating-box">
                        <div class="stars"><span class="star" *ngFor="let s of [1,2,3,4,5]" [class.on]="s <= (rating.stars||0)">★</span></div>
                        <div class="hint">TrustScore <strong>{{ rating.trustScore | number:'1.1-1' }}</strong> · {{ rating.numberOfReviews | number }} reviews</div>
                    </div>
                    <p class="hint" *ngIf="!rating">Connect Trustpilot or Google in Settings to show your live star rating in emails (optional — emails work without it).</p>
                </div></div>
            </vdr-page-block>
            <vdr-page-block>
                <div class="card"><div class="card-block">
                    <h3 class="step-title">Recent invitations</h3>
                    <table class="table" *ngIf="logRows.length; else noLog">
                        <thead><tr><th>When</th><th>Order</th><th>Customer</th><th>Status</th></tr></thead>
                        <tbody><tr *ngFor="let r of logRows.slice(0,10)">
                            <td class="hint">{{ r.createdAt | date:'d MMM HH:mm' }}</td>
                            <td><strong>{{ r.orderCode }}</strong></td><td>{{ r.email }}</td>
                            <td><span class="pill" [ngClass]="'st-'+r.status">{{ r.status }}<span *ngIf="r.reason"> · {{ r.reason }}</span></span></td>
                        </tr></tbody>
                    </table>
                    <ng-template #noLog><p class="hint">No invitations sent yet.</p></ng-template>
                </div></div>
            </vdr-page-block>
        </ng-container>

        <!-- SETTINGS -->
        <ng-container *ngIf="!loading && current && tab==='settings'">
            <vdr-page-block><div class="card"><div class="card-block">
                <h3 class="step-title">Where should reviews go?</h3>
                <p class="hint">Pick a platform and we build the review link. Trustpilot can also show your live star rating in the email (free API key). Google &amp; Reviews.io use the link only.</p>
                <div class="form-grid">
                    <div class="form-row"><label>Review platform</label>
                        <select class="form-input" [(ngModel)]="platform" (ngModelChange)="onPlatform()">
                            <option value="trustpilot">Trustpilot (recommended)</option>
                            <option value="google">Google reviews</option>
                            <option value="reviewsio">Reviews.io</option>
                            <option value="custom">Custom link</option>
                        </select></div>
                    <div class="form-row"><label>{{ platformLabel() }}</label>
                        <input class="form-input" [(ngModel)]="current.trustpilotDomain" (ngModelChange)="markDirty()" [placeholder]="platformPlaceholder()">
                        <div class="hint" style="margin-top:4px">{{ platformHelp() }}</div></div>
                    <div class="form-row" *ngIf="platform==='trustpilot' || platform==='google'"><label>{{ keyLabel() }} <small>(optional — for the star rating)</small></label>
                        <input class="form-input mono" [(ngModel)]="current.trustpilotApiKey" (ngModelChange)="markDirty()" placeholder="paste key or leave blank">
                        <div class="hint" style="margin-top:4px"><a [href]="keyLink()" target="_blank">{{ keyLinkText() }} &#8594;</a></div></div>
                </div>
                <div class="picker">
                    <button class="gbtn gbtn-primary gbtn-sm" (click)="connect()" [disabled]="connecting || !current.trustpilotDomain">{{ connecting ? 'Checking…' : (platform==='trustpilot' ? 'Connect Trustpilot' : platform==='google' ? 'Connect Google' : 'Check link') }}</button>
                    <span class="hint inline" *ngIf="connectMsg" [style.color]="connectOk ? 'var(--gb-amber-edge)' : 'var(--gb-muted)'">{{ connectMsg }}</span>
                </div>
                <div *ngIf="rating" class="rating-box" style="margin-top:6px">
                    <div class="stars"><span class="star" *ngFor="let s of [1,2,3,4,5]" [class.on]="s <= (rating.stars||0)">&#9733;</span></div>
                    <div class="hint">TrustScore <strong>{{ rating.trustScore | number:'1.1-1' }}</strong> &middot; {{ rating.numberOfReviews | number }} reviews</div>
                </div>
            </div></div></vdr-page-block>

            <vdr-page-block><div class="card"><div class="card-block">
                <h3 class="step-title">The basics</h3>
                <div class="form-grid">
                    <div class="form-row"><label>Business name <small>(shown in the email)</small></label>
                        <input class="form-input" [(ngModel)]="current.businessName" (ngModelChange)="markDirty()" placeholder="ELITE Software"></div>
                    <div class="form-row"><label>Ask this many days after the order</label>
                        <input class="form-input" type="number" min="0" [(ngModel)]="current.delayDays" (ngModelChange)="markDirty()"></div>
                    <div class="form-row"><label>What to ask for</label>
                        <select class="form-input" [(ngModel)]="current.reviewMode" (ngModelChange)="markDirty()">
                            <option value="service">A review of my store ({{ platform === 'google' ? 'Google' : 'Trustpilot' }})</option>
                            <option value="product">Reviews of the products they bought</option>
                            <option value="both">Both — store &amp; products</option>
                        </select></div>
                    <div class="form-row" *ngIf="current.reviewMode !== 'service'" style="grid-column:1/-1"><label>Product review link <small>(on your storefront — &#123;slug&#125;, &#123;name&#125; and &#123;orderCode&#125; are filled in)</small></label>
                        <input class="form-input mono" [(ngModel)]="current.productReviewUrlTemplate" (ngModelChange)="markDirty()" placeholder="https://elite-software.co.uk/product/&#123;slug&#125;?review=1">
                        <div class="hint" style="margin-top:4px">Each product on the order gets its own "Review this" button linking here. Point it at your product page's review form.</div></div>
                </div>
                <p class="hint" style="margin-top:8px">That's the essentials — flip the switch on at the top and you're live. Everything else has sensible defaults.</p>
            </div></div></vdr-page-block>

            <vdr-page-block><div class="card"><div class="card-block">
                <button class="gbtn gbtn-outline" (click)="advancedOpen = !advancedOpen" [attr.aria-expanded]="advancedOpen">{{ advancedOpen ? '&#9662; Hide advanced settings' : '&#9656; Advanced settings' }}</button>
                <span class="hint inline" style="margin-left:10px">trigger state, minimum value, cooldown, throttle, review-link, reply-to</span>
            </div></div></vdr-page-block>
            <vdr-page-block *ngIf="advancedOpen"><div class="card"><div class="card-block">
                <div class="form-grid">
                    <div class="form-row"><label>Send after order reaches</label>
                        <select class="form-input" [(ngModel)]="current.triggerState" (ngModelChange)="markDirty()">
                            <option value="Delivered">Delivered</option><option value="PaymentSettled">Payment settled</option><option value="Shipped">Shipped</option></select></div>
                    <div class="form-row"><label>Only orders over <small>(&pound;, 0 = any)</small></label>
                        <input class="form-input" type="number" min="0" [ngModel]="current.minOrderValuePence/100" (ngModelChange)="current.minOrderValuePence=$event*100; markDirty()"></div>
                    <div class="form-row"><label>Don't re-ask within <small>(days)</small></label>
                        <input class="form-input" type="number" min="0" [(ngModel)]="current.cooldownDays" (ngModelChange)="markDirty()"></div>
                    <div class="form-row"><label>Max per hourly run</label>
                        <input class="form-input" type="number" min="1" [(ngModel)]="current.maxPerRun" (ngModelChange)="markDirty()"></div>
                    <div class="form-row"><label>Reply-to <small>(optional)</small></label>
                        <input class="form-input" [(ngModel)]="current.replyTo" (ngModelChange)="markDirty()" placeholder="hello@yourstore.com"></div>
                    <div class="form-row" style="grid-column:1/-1"><label>Review link template <small>(&#123;domain&#125; is filled in &mdash; or point at Google, etc.)</small></label>
                        <input class="form-input mono" [(ngModel)]="current.reviewUrlTemplate" (ngModelChange)="markDirty()"></div>
                    <div class="form-row"><label>Business unit ID <small>(auto-filled by Connect)</small></label>
                        <input class="form-input mono" [(ngModel)]="current.trustpilotBusinessUnitId" (ngModelChange)="markDirty()"></div>
                </div>
            </div></div></vdr-page-block>
        </ng-container>

        <!-- EMAIL -->
        <ng-container *ngIf="!loading && current && tab==='email'">
            <vdr-page-block><div class="card"><div class="card-block">
                <h3 class="step-title">Invitation email <small>({{ current.channelCode }})</small></h3>
                <p class="hint">Variables: <code class="mono">&#123;&#123;firstName&#125;&#125;</code> <code class="mono">&#123;&#123;orderCode&#125;&#125;</code> <code class="mono">&#123;&#123;businessName&#125;&#125;</code> <code class="mono">&#123;&#123;reviewButton&#125;&#125;</code> <code class="mono">&#123;&#123;productList&#125;&#125;</code> <code class="mono">&#123;&#123;ratingBlock&#125;&#125;</code> · <span class="mini-chip" *ngIf="template?.isDefault">default</span><span class="mini-chip custom" *ngIf="template && !template.isDefault">customised</span></p>
                <div class="form-row"><label>Subject</label><input class="form-input" [(ngModel)]="template.subject" (ngModelChange)="tplDirty=true" *ngIf="template"></div>
                <div class="form-row"><label>Body <small>(HTML)</small></label><textarea class="form-input" rows="12" style="max-width:100%;font-family:ui-monospace,monospace;font-size:12px" [(ngModel)]="template.body" (ngModelChange)="tplDirty=true" *ngIf="template"></textarea></div>
                <div class="picker">
                    <button class="gbtn gbtn-primary gbtn-sm" (click)="saveTemplate()" [disabled]="!tplDirty">Save email</button>
                    <button class="gbtn gbtn-outline gbtn-sm" (click)="previewTemplate()">Preview</button>
                    <button class="gbtn gbtn-ghost gbtn-sm" (click)="resetTemplate()" [disabled]="template?.isDefault">Reset to default</button>
                </div>
                <div *ngIf="preview" class="tpl-preview">
                    <div class="tpl-preview-subject">{{ preview.subject }}</div>
                    <div [innerHTML]="safeHtml(preview.html)"></div>
                </div>
                <h4 class="subsection-title">Send a test</h4>
                <div class="picker">
                    <input class="form-input" style="max-width:280px" [(ngModel)]="testEmail" placeholder="you@yourstore.com">
                    <button class="gbtn gbtn-outline gbtn-sm" (click)="sendTest()" [disabled]="!testEmail || testing">{{ testing ? 'Sending…' : 'Send test' }}</button>
                </div>
            </div></div></vdr-page-block>
        </ng-container>

        <!-- EXCLUSIONS -->
        <ng-container *ngIf="!loading && current && tab==='exclusions'">
            <vdr-page-block><div class="card"><div class="card-block">
                <h3 class="step-title">Excluded customers</h3>
                <p class="hint">Emails or whole domains that never get a review request — wholesale accounts, staff, anyone who asked not to be contacted. Customers who click "unsubscribe" in an email are added automatically ({{ stats?.optOuts || 0 }} so far).</p>

                <h4 class="subsection-title">Find a customer</h4>
                <div class="picker">
                    <input class="form-input" style="min-width:300px" placeholder="Search customers by name or email…" [(ngModel)]="custQuery" (ngModelChange)="onCustSearch()">
                    <span class="hint inline" *ngIf="custSearching">Searching…</span>
                </div>
                <div class="cust-results" *ngIf="custQuery.length>=2 && !custSearching">
                    <div class="cust-row" *ngFor="let c of custResults">
                        <div class="cust-info"><strong>{{ c.firstName }} {{ c.lastName }}</strong><span class="hint mono">{{ c.email }}</span></div>
                        <span class="pill st-skipped" *ngIf="c.excluded" [title]="'Already ' + c.via">✓ {{ c.via }}</span>
                        <button class="gbtn gbtn-outline gbtn-sm" *ngIf="!c.excluded" (click)="excludeCustomer(c)">Exclude</button>
                    </div>
                    <p class="hint" *ngIf="!custResults.length">No customers match “{{ custQuery }}”.</p>
                </div>

                <h4 class="subsection-title">Or add manually</h4>
                <div class="picker">
                    <select class="form-select" style="min-width:150px" [(ngModel)]="newExcl.type">
                        <option value="email">email</option><option value="email_domain">email domain</option>
                    </select>
                    <input class="form-input" placeholder="value" [(ngModel)]="newExcl.value" (keyup.enter)="addExclusion()">
                    <input class="form-input" placeholder="note (optional)" [(ngModel)]="newExcl.note">
                    <button class="gbtn gbtn-outline gbtn-sm" (click)="addExclusion()" [disabled]="!newExcl.value">+ Add</button>
                </div>
                <table class="table" *ngIf="exclusions.length">
                    <thead><tr><th>Type</th><th>Value</th><th>Note</th><th></th></tr></thead>
                    <tbody><tr *ngFor="let e of exclusions">
                        <td>{{ e.type }}</td><td class="mono">{{ e.value }}</td><td class="hint">{{ e.note }}</td>
                        <td class="num-col"><button class="chip-x" (click)="removeExclusion(e)" [attr.aria-label]="'Remove '+e.value">×</button></td>
                    </tr></tbody>
                </table>
                <p class="hint" *ngIf="!exclusions.length">No exclusions yet.</p>
            </div></div></vdr-page-block>
        </ng-container>

        <!-- ACTIVITY -->
        <ng-container *ngIf="!loading && current && tab==='activity'">
            <vdr-page-block><div class="card"><div class="card-block">
                <div class="row-between"><h3 class="step-title" style="margin:0">Send log</h3>
                    <select class="form-select" [(ngModel)]="logStatus" (ngModelChange)="loadLog()">
                        <option value="">all</option><option value="sent">sent</option><option value="skipped">skipped</option><option value="failed">failed</option>
                    </select></div>
                <table class="table" *ngIf="logRows.length; else noAct">
                    <thead><tr><th>When</th><th>Order</th><th>Customer</th><th>Status</th><th>Detail</th></tr></thead>
                    <tbody><tr *ngFor="let r of logRows">
                        <td class="hint">{{ r.createdAt | date:'d MMM HH:mm' }}</td>
                        <td><strong>{{ r.orderCode }}</strong></td><td>{{ r.email }}</td>
                        <td><span class="pill" [ngClass]="'st-'+r.status">{{ r.status }}</span></td>
                        <td class="hint">{{ r.reason || '—' }}</td>
                    </tr></tbody>
                </table>
                <ng-template #noAct><p class="hint">Nothing logged yet.</p></ng-template>
            </div></div></vdr-page-block>
        </ng-container>

        <!-- SAVE BAR -->
        <vdr-page-block *ngIf="!loading && current && (tab==='settings' || tab==='overview')">
            <div class="save-bar" [class.is-dirty]="dirty">
                <span class="save-msg" *ngIf="dirty"><span class="save-dot"></span> Unsaved changes</span>
                <span class="save-msg quiet" *ngIf="!dirty">All changes saved</span>
                <span class="save-spacer"></span>
                <button class="gbtn gbtn-ghost" (click)="reloadAll()" [disabled]="saving || !dirty">Discard</button>
                <button class="gbtn gbtn-primary" (click)="save()" [disabled]="saving || !dirty">{{ saving ? 'Saving…' : 'Save changes' }}</button>
            </div>
        </vdr-page-block>
    `,
    styles: [`
        :host { display:block; color:var(--gb-strong); }
        :host {
            --gb-surface:var(--color-component-bg-100,#fafafa); --gb-surface-2:var(--color-component-bg-200,#f2f3f5);
            --gb-line:var(--color-component-border-200,#d5d8de); --gb-line-soft:var(--color-component-border-100,#e8eaee);
            --gb-strong:#3d4147; --gb-muted:#5d6470; --gb-ui-border:#79818f;
            --gb-amber:#f59e0b; --gb-amber-hover:#e18f06; --gb-amber-edge:#b45309; --gb-amber-ink:#231602;
            --gb-danger-ink:#b91c1c; --gb-ok:#10b981; --gb-warn:#f59e0b; --gb-bad:#ef4444; --gb-info:#3b82f6;
            --gb-tint-ok:color-mix(in srgb,var(--gb-ok) 10%,var(--gb-surface)); --gb-tint-warn:color-mix(in srgb,var(--gb-warn) 12%,var(--gb-surface));
            --gb-tint-bad:color-mix(in srgb,var(--gb-bad) 10%,var(--gb-surface)); --gb-tint-info:color-mix(in srgb,var(--gb-info) 10%,var(--gb-surface));
            --gb-line-ok:color-mix(in srgb,var(--gb-ok) 45%,transparent); --gb-line-warn:color-mix(in srgb,var(--gb-warn) 50%,transparent);
            --gb-line-bad:color-mix(in srgb,var(--gb-bad) 45%,transparent); --gb-line-info:color-mix(in srgb,var(--gb-info) 45%,transparent);
            --gb-shadow-1:0 1px 2px rgba(15,23,42,.06);
        }
        :host-context([data-theme='dark']) { --gb-strong:var(--color-text-100,hsl(210,16%,93%)); --gb-muted:hsl(205,14%,74%); --gb-ui-border:hsl(203,12%,50%); --gb-amber-edge:#f59e0b; --gb-danger-ink:#f87171; --gb-shadow-1:0 1px 2px rgba(0,0,0,.35); }
        .gbtn { display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:36px; padding:0 16px; border-radius:8px; font-size:13px; font-weight:600; border:1px solid transparent; background:none; cursor:pointer; color:var(--gb-strong); text-decoration:none; transition:background .12s,border-color .12s,color .12s; }
        .gbtn:disabled { opacity:.45; cursor:not-allowed; }
        .gbtn-sm { min-height:30px; padding:0 12px; font-size:12px; }
        .gbtn-primary { background:var(--gb-amber); border-color:var(--gb-amber-edge); color:var(--gb-amber-ink); box-shadow:var(--gb-shadow-1); }
        .gbtn-primary:hover:not(:disabled){ background:var(--gb-amber-hover); }
        .gbtn-outline { border-color:var(--gb-ui-border); background:var(--gb-surface); }
        .gbtn-outline:hover:not(:disabled){ border-color:var(--gb-amber-edge); background:var(--gb-surface-2); }
        .gbtn-ghost { color:var(--gb-muted); } .gbtn-ghost:hover:not(:disabled){ color:var(--gb-strong); background:var(--gb-surface-2); }
        .gbtn-hero { color:#e2e8f0; } .gbtn-hero:hover:not(:disabled){ color:#fff; background:rgba(255,255,255,.12); }
        .hulo-hero { display:flex; align-items:center; gap:18px; padding:20px 22px; border-radius:14px; background:linear-gradient(135deg,#0f1419,#1e293b); color:#fff; box-shadow:0 1px 3px rgba(15,23,42,.15),0 8px 24px rgba(15,23,42,.08); }
        .hulo-hero-logo { flex:0 0 auto; width:56px; height:56px; } .hulo-hero-logo svg { width:100%; height:100%; display:block; }
        .hulo-hero-text { flex:1; min-width:0; } .hulo-hero-title { color:#fff; font-size:22px; font-weight:700; margin:0; }
        .hulo-hero-sub { color:#cbd5e1; font-size:13px; line-height:1.5; margin:4px 0 0; max-width:720px; }
        .hulo-hero-actions { display:flex; gap:6px; }
        .card { background:var(--gb-surface); border:1px solid var(--gb-line); border-radius:12px; box-shadow:var(--gb-shadow-1); margin-bottom:16px; }
        .card-block { padding:18px 20px; }
        .row-between { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:8px; }
        .step-title { font-size:15px; font-weight:700; color:var(--gb-strong); margin:0 0 4px; } .step-title small { font-weight:500; font-size:12px; color:var(--gb-muted); }
        .subsection-title { margin:20px 0 10px; font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--gb-muted); }
        .hint { font-size:12px; color:var(--gb-muted); margin:2px 0 12px; } .hint.inline { display:inline; margin:0; }
        .mono { font-family:ui-monospace,monospace; }
        .top-bar { border-left:4px solid var(--gb-amber); }
        .chan-row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
        .lbl { font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--gb-muted); }
        .form-select, .form-input { padding:7px 10px; border-radius:8px; min-height:36px; border:1px solid var(--gb-ui-border); background:var(--gb-surface); color:var(--gb-strong); font-size:13px; }
        .form-select:focus, .form-input:focus { outline:none; border-color:var(--gb-amber-edge); box-shadow:0 0 0 3px color-mix(in srgb,var(--gb-amber) 30%,transparent); }
        .form-select { min-width:180px; }
        .gb-switch-group { display:inline-flex; align-items:center; gap:8px; }
        .gb-switch { position:relative; width:44px; height:24px; border-radius:999px; border:1px solid transparent; padding:0; background:var(--gb-ui-border); cursor:pointer; }
        .gb-switch.on { background:var(--gb-amber); border-color:var(--gb-amber-edge); }
        .gb-switch-knob { position:absolute; top:2px; left:2px; width:18px; height:18px; border-radius:50%; background:#fff; box-shadow:0 1px 2px rgba(15,23,42,.35); transition:transform .15s; }
        .gb-switch.on .gb-switch-knob { transform:translateX(20px); }
        .gb-switch-label { font-size:13px; font-weight:700; }
        .dirty-flag { font-size:12px; font-weight:700; color:var(--gb-amber-edge); }
        .status-sentence { margin:12px 0 0; padding:10px 14px; border-radius:8px; font-size:13px; line-height:1.5; background:var(--gb-tint-ok); border:1px solid var(--gb-line-ok); border-left-width:4px; }
        .status-sentence.status-off { background:var(--gb-surface-2); border-color:var(--gb-line); color:var(--gb-muted); }
        .tabs { display:flex; gap:4px; margin-top:14px; flex-wrap:wrap; border-top:1px solid var(--gb-line-soft); padding-top:12px; }
        .tab { display:inline-flex; align-items:center; gap:6px; padding:7px 14px; min-height:34px; border-radius:999px; border:1px solid transparent; background:none; cursor:pointer; font-size:13px; font-weight:600; color:var(--gb-muted); }
        .tab:hover { color:var(--gb-strong); background:var(--gb-surface-2); } .tab.active { background:var(--gb-amber); border-color:var(--gb-amber-edge); color:var(--gb-amber-ink); }
        .tab-count { font-size:10px; font-weight:800; min-width:16px; height:16px; padding:0 4px; border-radius:999px; display:inline-grid; place-items:center; background:color-mix(in srgb,currentColor 18%,transparent); }
        .kpi-row { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; }
        .kpi { background:var(--gb-surface); border:1px solid var(--gb-line); border-radius:12px; padding:16px 18px; }
        .kpi-alert { border-color:var(--gb-line-warn); border-left:4px solid var(--gb-amber); }
        .kpi-label { font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--gb-muted); }
        .kpi-num { margin-top:6px; font-size:26px; font-weight:700; color:var(--gb-strong); font-variant-numeric:tabular-nums; }
        .kpi-sub { margin-top:4px; font-size:12px; color:var(--gb-muted); }
        .form-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:12px 18px; }
        .form-row label { display:block; font-size:12px; font-weight:700; color:var(--gb-strong); margin-bottom:4px; } .form-row label small { font-weight:500; color:var(--gb-muted); }
        .form-row .form-input, .form-row .form-select { width:100%; }
        .rating-box { display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
        .stars { font-size:22px; letter-spacing:2px; } .star { color:#dcdce6; } .star.on { color:#00b67a; }
        .table { width:100%; border-collapse:collapse; font-size:13px; }
        .table th { text-align:left; font-size:11px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--gb-muted); padding:8px 10px; border-bottom:1px solid var(--gb-line); }
        .table td { padding:9px 10px; border-bottom:1px solid var(--gb-line-soft); color:var(--gb-strong); }
        .table .num-col { text-align:right; }
        .pill { font-size:11px; font-weight:700; padding:2px 9px; border-radius:999px; border:1px solid var(--gb-line); background:var(--gb-surface-2); }
        .st-sent { background:var(--gb-tint-ok); border-color:var(--gb-line-ok); } .st-skipped { background:var(--gb-tint-info); border-color:var(--gb-line-info); } .st-failed { background:var(--gb-tint-bad); border-color:var(--gb-line-bad); }
        .picker { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:12px; }
        .form-row { margin-bottom:14px; }
        .mini-chip { font-size:11px; font-weight:600; padding:2px 7px; border-radius:5px; background:var(--gb-surface); border:1px solid var(--gb-line-warn); color:var(--gb-strong); }
        .mini-chip.custom { border-color:var(--gb-line-info); }
        .chip-x { display:inline-grid; place-items:center; min-width:22px; min-height:22px; border-radius:999px; background:none; border:0; cursor:pointer; font-size:15px; color:var(--gb-muted); }
        .chip-x:hover { color:var(--gb-danger-ink); background:var(--gb-tint-bad); }
        .tpl-preview { margin-top:14px; padding:16px 18px; border-radius:10px; border:1px dashed var(--gb-ui-border); background:#fff; color:#0f172a; font-size:13px; }
        .tpl-preview-subject { font-weight:700; margin-bottom:10px; padding-bottom:8px; border-bottom:1px solid var(--gb-line); }
        .save-bar { position:sticky; bottom:12px; z-index:5; display:flex; align-items:center; gap:10px; padding:12px 16px; border-radius:12px; background:var(--gb-surface); border:1px solid var(--gb-line); box-shadow:var(--gb-shadow-1); }
        .save-bar.is-dirty { border-color:var(--gb-amber-edge); box-shadow:0 8px 24px rgba(15,23,42,.18); }
        .save-msg { display:inline-flex; align-items:center; gap:8px; font-size:13px; font-weight:600; } .save-msg.quiet { color:var(--gb-muted); font-weight:500; }
        .save-dot { width:8px; height:8px; border-radius:50%; background:var(--gb-amber); box-shadow:0 0 0 3px color-mix(in srgb,var(--gb-amber) 25%,transparent); }
        .save-spacer { flex:1; }
        .cust-results { border:1px solid var(--gb-line); border-radius:10px; overflow:hidden; margin-bottom:12px; }
        .cust-row { display:flex; align-items:center; gap:12px; padding:10px 14px; }
        .cust-row + .cust-row { border-top:1px solid var(--gb-line-soft); }
        .cust-row:hover { background:var(--gb-surface-2); }
        .cust-info { flex:1; display:flex; flex-direction:column; gap:2px; min-width:0; }
        .cust-info strong { font-size:13px; } .cust-info .hint { margin:0; }
        .update-banner { display:flex; gap:12px; align-items:center; justify-content:space-between; flex-wrap:wrap; padding:12px 16px; border-radius:10px; font-size:13px; background:var(--gb-tint-warn); border:1px solid var(--gb-line-warn); }
        .update-banner .actions { display:flex; gap:6px; }
    `],
})
export class ReviewRequestsComponent implements OnInit {
    loading = true;
    meta: any = null;
    configs: ReviewConfig[] = [];
    currentIdx = 0;
    dirty = false; saving = false;
    tab: Tab = 'overview';
    stats: any = null;
    rating: any = null;
    logRows: any[] = [];
    logStatus = '';
    exclusions: any[] = [];
    newExcl = { type: 'email', value: '', note: '' };
    custQuery = ''; custResults: any[] = []; custSearching = false; private custTimer: any;
    template: any = null; tplDirty = false; preview: any = null;
    testEmail = ''; testing = false;
    running = false; checking = false; checkMsg = '';
    advancedOpen = false; connecting = false; connectMsg = ''; connectOk = false;
    platform = 'trustpilot';
    platformTemplates: any = { trustpilot: 'https://www.trustpilot.com/evaluate/{domain}', google: 'https://search.google.com/local/writereview?placeid={domain}', reviewsio: 'https://www.reviews.io/company-review/store/{domain}/new' };

    constructor(private http: HttpClient, private notify: NotificationService, private cdr: ChangeDetectorRef, private sanitizer: DomSanitizer) {}

    get current(): ReviewConfig | null { return this.configs[this.currentIdx] || null; }

    ngOnInit() {
        this.reloadAll();
        this.http.get<any>('/review-requests/meta').subscribe({ next: m => { this.meta = m; this.cdr.markForCheck(); }, error: () => undefined });
    }

    reloadAll() {
        this.loading = true; this.dirty = false;
        this.http.get<ReviewConfig[]>('/review-requests/config').subscribe({
            next: c => { this.configs = c; if (this.currentIdx >= c.length) this.currentIdx = 0; this.loading = false; this.derivePlatform(); this.loadForTab(this.tab); this.cdr.markForCheck(); },
            error: () => { this.loading = false; this.notify.error('Failed to load review-request config'); },
        });
    }
    onChannel() { this.dirty = false; this.rating = null; this.derivePlatform(); this.loadForTab(this.tab); }
    derivePlatform() {
        const t = this.current?.reviewUrlTemplate || '';
        if (t.includes('trustpilot.com')) this.platform = 'trustpilot';
        else if (t.includes('google.com')) this.platform = 'google';
        else if (t.includes('reviews.io')) this.platform = 'reviewsio';
        else this.platform = 'custom';
    }
    onPlatform() {
        if (!this.current) return;
        if (this.platform !== 'custom') this.current.reviewUrlTemplate = this.platformTemplates[this.platform];
        this.connectMsg = ''; this.rating = null;
        this.markDirty();
    }
    platformLabel(): string {
        return this.platform === 'google' ? 'Your Google Place ID'
            : this.platform === 'reviewsio' ? 'Your Reviews.io store ID'
            : this.platform === 'custom' ? 'Your identifier (fills {domain} in the link)'
            : 'Your Trustpilot domain';
    }
    platformPlaceholder(): string {
        return this.platform === 'google' ? 'ChIJ… (Google Place ID)'
            : this.platform === 'reviewsio' ? 'your-store-id'
            : this.platform === 'custom' ? 'value for {domain}'
            : 'elite-software.co.uk';
    }
    keyLabel(): string { return this.platform === 'google' ? 'Google Maps API key' : 'Trustpilot API key'; }
    keyLink(): string { return this.platform === 'google' ? 'https://console.cloud.google.com/apis/library/places-backend.googleapis.com' : 'https://developers.trustpilot.com/'; }
    keyLinkText(): string { return this.platform === 'google' ? 'Enable the Places API' : 'Get a free key'; }
    platformHelp(): string {
        return this.platform === 'google' ? 'Find your Place ID at developers.google.com/maps/documentation/places/web-service/place-id. Add a Google Maps API key (Places API) below and we pull your live Google star rating too.'
            : this.platform === 'reviewsio' ? 'Your Reviews.io store ID from your Reviews.io dashboard.'
            : this.platform === 'custom' ? 'Edit the full link template under Advanced settings.'
            : 'Your domain exactly as it appears on Trustpilot.';
    }
    go(t: Tab) { this.tab = t; this.loadForTab(t); }
    private loadForTab(t: Tab) {
        if (t === 'overview') { this.loadStats(); this.loadLog(); }
        if (t === 'email') this.loadTemplate();
        if (t === 'exclusions') { this.loadExclusions(); this.loadStats(); }
        if (t === 'activity') this.loadLog();
    }

    markDirty() { this.dirty = true; }
    statusSentence(): string {
        const c = this.current; if (!c) return '';
        if (!c.enabled) return 'Review requests are OFF for this channel — nothing is sent.';
        const val = c.minOrderValuePence ? ` over £${(c.minOrderValuePence/100).toFixed(0)}` : '';
        const tp = c.trustpilotDomain ? `your Trustpilot page for ${c.trustpilotDomain}` : '(set your Trustpilot domain in Settings)';
        return `${c.delayDays} days after an order${val} reaches ${c.triggerState}, the customer is invited to review ${tp} — at most once every ${c.cooldownDays} days.`;
    }
    save() {
        if (!this.current) return; this.saving = true;
        this.http.post('/review-requests/config', { configs: [this.current] }).subscribe({
            next: () => { this.saving = false; this.dirty = false; this.notify.success('Settings saved'); this.cdr.markForCheck(); },
            error: () => { this.saving = false; this.notify.error('Save failed'); },
        });
    }

    loadStats() { this.http.get<any>('/review-requests/stats').subscribe({ next: s => { this.stats = s; this.cdr.markForCheck(); }, error: () => undefined }); }
    pendingTotal(): number { return (this.stats?.pending || []).reduce((n: number, r: any) => n + (r.eligible || 0), 0); }
    loadLog() { const q = this.logStatus ? `?status=${this.logStatus}` : ''; this.http.get<any[]>(`/review-requests/log${q}`).subscribe({ next: r => { this.logRows = r; this.cdr.markForCheck(); }, error: () => undefined }); }
    loadExclusions() { this.http.get<any[]>('/review-requests/exclusions').subscribe({ next: r => { this.exclusions = r; this.cdr.markForCheck(); }, error: () => undefined }); }

    runNow() {
        this.running = true;
        this.http.post<any>('/review-requests/run', {}).subscribe({
            next: r => { this.running = false; const sent = (r.results||[]).reduce((n:number,x:any)=>n+(x.sent||0),0); this.notify.success(`Sent ${sent} invitation(s)`); this.loadStats(); this.loadLog(); },
            error: err => { this.running = false; this.notify.error(err?.error?.message || 'Run failed'); },
        });
    }
    connect() {
        if (!this.current) return; this.connecting = true; this.connectMsg = ''; this.connectOk = false;
        this.http.post<any>('/review-requests/trustpilot/detect', this.current).subscribe({
            next: r => {
                this.connecting = false; this.connectOk = r.ok && (!!r.rating || !!r.businessUnitId || !this.current!.trustpilotApiKey);
                this.connectMsg = r.message;
                if (r.businessUnitId && this.current) { this.current.trustpilotBusinessUnitId = r.businessUnitId; this.markDirty(); }
                if (!this.current!.businessName && this.current) { /* leave for the user */ }
                this.rating = r.rating || null; this.cdr.markForCheck();
            },
            error: () => { this.connecting = false; this.connectMsg = 'Connection failed — try again.'; },
        });
    }

    checkRating() {
        if (!this.current) return; this.checking = true; this.checkMsg = '';
        this.http.post<any>('/review-requests/trustpilot/check', this.current).subscribe({
            next: r => { this.checking = false; this.rating = r.rating; this.checkMsg = r.ok ? `✓ ${r.rating.trustScore} from ${r.rating.numberOfReviews} reviews · link: ${r.reviewUrl}` : `Link: ${r.reviewUrl} (no live rating — check API key/domain)`; this.cdr.markForCheck(); },
            error: () => { this.checking = false; this.checkMsg = 'Check failed'; },
        });
    }

    loadTemplate() { if (!this.current) return; this.preview = null; this.tplDirty = false; this.http.get<any>(`/review-requests/template?channelId=${this.current.channelId}`).subscribe({ next: t => { this.template = t; this.cdr.markForCheck(); }, error: () => undefined }); }
    saveTemplate() { if (!this.current || !this.template) return; this.http.post('/review-requests/template', { channelId: this.current.channelId, subject: this.template.subject, body: this.template.body }).subscribe({ next: () => { this.tplDirty = false; this.notify.success('Email saved'); this.loadTemplate(); }, error: () => this.notify.error('Save failed') }); }
    resetTemplate() { if (!this.current) return; this.http.post('/review-requests/template', { channelId: this.current.channelId, reset: true }).subscribe({ next: () => { this.notify.success('Reset to default'); this.loadTemplate(); }, error: () => this.notify.error('Failed') }); }
    previewTemplate() { if (!this.current || !this.template) return; this.http.post<any>('/review-requests/template/preview', { channelId: this.current.channelId, subject: this.template.subject, body: this.template.body }).subscribe({ next: p => { this.preview = p; this.cdr.markForCheck(); }, error: () => this.notify.error('Preview failed') }); }
    safeHtml(html: string): SafeHtml { return this.sanitizer.bypassSecurityTrustHtml(html); }
    sendTest() {
        if (!this.current || !this.testEmail) return; this.testing = true;
        this.http.post<any>('/review-requests/test-send', { channelId: this.current.channelId, email: this.testEmail }).subscribe({
            next: r => { this.testing = false; r.ok ? this.notify.success('Test sent — check your inbox') : this.notify.error(r.reason || 'Send failed'); },
            error: err => { this.testing = false; this.notify.error(err?.error?.reason || 'Send failed'); },
        });
    }

    onCustSearch() {
        clearTimeout(this.custTimer);
        const q = this.custQuery.trim();
        if (q.length < 2) { this.custResults = []; this.custSearching = false; return; }
        this.custSearching = true;
        this.custTimer = setTimeout(() => {
            this.http.get<any[]>(`/review-requests/customers/search?q=${encodeURIComponent(q)}`).subscribe({
                next: r => { this.custSearching = false; this.custResults = r; this.cdr.markForCheck(); },
                error: () => { this.custSearching = false; this.cdr.markForCheck(); },
            });
        }, 250);
    }
    excludeCustomer(c: any) {
        const name = [c.firstName, c.lastName].filter(Boolean).join(' ');
        this.http.post('/review-requests/exclusions', { type: 'email', value: c.email, note: name || 'customer' }).subscribe({
            next: () => { c.excluded = true; c.via = 'excluded'; this.loadExclusions(); this.notify.success(`Excluded ${c.email}`); this.cdr.markForCheck(); },
            error: () => this.notify.error('Failed to exclude'),
        });
    }

    addExclusion() { if (!this.newExcl.value) return; this.http.post('/review-requests/exclusions', this.newExcl).subscribe({ next: () => { this.newExcl = { type: 'email', value: '', note: '' }; this.loadExclusions(); }, error: () => this.notify.error('Failed to add') }); }
    removeExclusion(e: any) { this.http.delete(`/review-requests/exclusions/${e.id}`).subscribe({ next: () => { this.exclusions = this.exclusions.filter(x => x.id !== e.id); this.cdr.markForCheck(); }, error: () => this.notify.error('Failed') }); }
}
