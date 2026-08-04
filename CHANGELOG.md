# Changelog

All notable changes to `@huloglobal/vendure-plugin-review-requests` are documented
here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this project
follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

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
