import { NgModule } from '@angular/core';
import { SharedModule, addNavMenuItem, registerDashboardWidget } from '@vendure/admin-ui/core';

/**
 * Registers the "Review Requests" entry in the admin nav (Marketing
 * section) and the dashboard widget (Dashboard → Add widget → Review
 * Requests). Both are gated on the same permission the page itself reads
 * with.
 */
@NgModule({
    imports: [SharedModule],
    providers: [
        addNavMenuItem(
            {
                id: 'hulo-vendure-plugin-review-requests',
                label: 'Review Requests',
                routerLink: ['/extensions/review-requests'],
                icon: 'star',
                requiresPermission: 'ReadSettings',
            },
            'marketing',
        ),
        registerDashboardWidget('hulo-vendure-plugin-review-requests', {
            title: 'Review Requests',
            supportedWidths: [4, 6, 8],
            requiresPermissions: ['ReadSettings'],
            loadComponent: () => import('./components/review-requests-widget.component').then(m => m.ReviewRequestsWidgetComponent),
        }),
    ],
})
export class ReviewRequestsNavModule {}
