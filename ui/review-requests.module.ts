import { NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';
import { SharedModule } from '@vendure/admin-ui/core';
import { FormsModule } from '@angular/forms';
import { HttpClientModule } from '@angular/common/http';
import { ReviewRequestsComponent } from './components/review-requests.component';

@NgModule({
    imports: [
        SharedModule, FormsModule, HttpClientModule,
        RouterModule.forChild([
            { path: '', pathMatch: 'full', component: ReviewRequestsComponent, data: { breadcrumb: 'Review requests' } },
        ]),
    ],
    declarations: [ReviewRequestsComponent],
})
export class ReviewRequestsModule {}
