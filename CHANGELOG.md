# Changelog

All notable changes to `@huloglobal/vendure-plugin-review-requests` are documented
here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this project
follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-08-04

### Added
- **Google reviews live rating.** Pick Google in the platform selector,
  add a Google Maps API key (Places API) + your Place ID, and Connect —
  the email now shows your live Google star rating + review count, the
  same way Trustpilot does. Both platforms cache for 6h and fail open.

## [0.3.0] — 2026-08-04

### Added
- **Live customer search in Exclusions.** Type a name or email and pick a
  real customer to exclude — each result shows whether they're *already*
  excluded (and why: excluded / domain rule / unsubscribed), so it doubles
  as a quick "is this customer excluded?" check.
- **Review-platform picker.** Choose Trustpilot / Google reviews /
  Reviews.io / Custom and the review link is built for you (Trustpilot
  keeps the live-rating auto-detect; the others use the link only). Any
  site with a review URL already worked via the template — this makes it
  one click.
- Endpoints: `GET /review-requests/customers/search`,
  `GET /review-requests/exclusions/check`.

## [0.2.0] — 2026-08-04

### Changed
- **Simpler setup.** The Settings tab now opens with a one-click
  **Connect Trustpilot**: enter your domain (and an optional free API
  key) and the plugin auto-detects your business-unit id and pulls your
  live star rating — no manual lookups. Just a domain, a business name
  and "days after order" are on the main screen; everything else moved
  behind an Advanced toggle.

### Added
- `POST /review-requests/trustpilot/detect` — resolve review link +
  business-unit id + live rating from a domain (+ key) in one call.

## [0.1.0] — 2026-08-04

First release.

### Added
- **Order-date-timed review invitations.** Hourly worker invites customers whose
  order reached a trigger state (Delivered / PaymentSettled / Shipped) a
  configurable number of days ago.
- **Free Trustpilot integration.** Review button links to the free
  `trustpilot.com/evaluate/<domain>` page (organic reviews, no paid AFS). Optional
  free Trustpilot API key reads the live TrustScore + review count to show as
  social proof in the email. Link template is configurable (Google, etc.).
- **Customer exclusions** by email or domain, plus signed one-click **unsubscribe**
  that auto-excludes.
- **Dedup + cooldown + minimum order value** so nobody is over-asked.
- **Editable email template** per channel, with live preview and **test-send**.
- **Multi-tab admin dashboard** (Overview / Settings / Email / Exclusions /
  Activity) on the HULO design system, with a send log and eligibility preview.
- HULO licence SDK: free tier = configure + preview + test-send; scheduled sending
  is licensed. Admin REST requires an authenticated admin session.
