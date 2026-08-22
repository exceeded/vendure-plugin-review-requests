import { NgModule } from '@angular/core';
import { SharedModule, registerCustomDetailComponent } from '@vendure/admin-ui/core';
import { OrderReviewPanelComponent } from './components/order-review-panel.component';

/** Embeds the review-invitation panel on the admin order-detail page. */
@NgModule({
    imports: [SharedModule],
    providers: [
        registerCustomDetailComponent({
            locationId: 'order-detail',
            component: OrderReviewPanelComponent,
        }),
    ],
})
export class OrderReviewSharedModule {}
