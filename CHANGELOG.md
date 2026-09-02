# Changelog

All notable changes to `@huloglobal/vendure-plugin-review-requests` are documented
here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this project
follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.14.0] — 2026-09-02

### Added
- **Buy licence from the admin.** The evaluation / free-tier banner now has a plan picker and a **Buy licence** button: checkout opens in a new tab and, once payment completes, the licence **installs itself** — no email round-trip, no `.env` edit, no restart. Renewed subscription keys are picked up automatically too. New admin endpoints `licence/purchase-link` and `licence/claim-status`.

### Changed
- Requires `@huloglobal/vendure-licence-sdk` ^0.12.0.
- The 7-day card trial at checkout has been retired: every install already gets the 14-day no-card evaluation, and paid plans now bill from day one.

## [0.13.3] — 2026-09-02

### Changed
- **Licence SDK ^0.11.0.** Master licences (one key that activates every HULO plugin) and hardware-bound keys are now accepted by the runtime licence check.
- **Branding.** Refreshed HULO Global logo (inline HG monogram) in the admin UI.

## [0.13.2] — 2026-08-25

### Fixed
- **Double-send race hardening.** The hourly cron now carries a
  single-flight guard: schedule explorers were observed firing the handler
  twice in the same tick, and two overlapping scans could have raced past
  the per-order dedup and emailed a customer twice. Duplicate invocations
  now exit immediately.
- **Cleaner audit log.** A skipped order (excluded / cooldown) is logged
  once per reason instead of on every hourly re-scan of its window.

## [0.13.1] — 2026-08-25

### Fixed
- **Eligibility scan never found any orders.** The candidate query assumed
  an `order.channelId` column, but Vendure stores the order↔channel
  relation in the `order_channels_channel` join table — so the hourly scan
  failed on every install (the error was caught and logged, and no
  invitations were ever sent). The scan, the admin order panel and manual
  send now resolve the channel through the join table.

## [0.13.0] — 2026-08-25

### Added
- **PostgreSQL support.** All of the plugin's SQL now runs on Postgres as
  well as MySQL/MariaDB — the licence SDK's new dialect adapter translates
  queries transparently at runtime, so no configuration is needed: the
  plugin follows whatever database your Vendure `dbConnectionOptions` use.
  Verified against PostgreSQL 17. MySQL/MariaDB installs are unaffected
  (byte-identical passthrough).

## [0.12.1] — 2026-08-25

### Changed
- The update banner's "What's new" link now opens the plugin's
  changelog page on huloglobal.com, so you can read exactly what a
  release contains before updating.

## [0.12.0] — 2026-08-23

### Added
- **One-click in-app updates.** The update banner now has an "Update
  now" button: the plugin installs the new version via your project's
  own package manager (yarn/npm/pnpm auto-detected), verifies it landed,
  and gracefully restarts under your process supervisor (pm2/systemd).
  Admin-only; the target version is verified against the npm registry;
  a failed install never restarts anything. Disable with
  HULO_SELF_UPDATE=off; force restart without a detected supervisor
  with HULO_SELF_UPDATE=force. Note: a separate worker process picks
  the update up on its next restart, and the admin UI itself refreshes
  after your next admin build.

## [0.11.1] — 2026-08-23

### Added
- **Update notifications in the admin UI.** When a newer version is on
  npm, a dismissible banner shows current → latest with a copy-ready
  install command and a link to what's new. (Update data comes from the
  existing daily registry check — no new network calls.)

## [0.11.0] — 2026-08-22

### Added
- **Review panel on the admin order page.** Shows whether this order's
  customer was invited to review (with history), and lets staff send
  the invitation manually — including a confirmed force-resend and a
  confirmed override for excluded customers. Opt-outs are always
  honoured server-side. Light/dark theme aware. New
  GET order-status/:orderId + POST send-order/:orderId endpoints.

## [0.10.0] — 2026-08-21

### Added
- **In-admin licence activation.** Paste your key into the plugin's
  admin page and it verifies (signature, plugin id, domain binding,
  expiry, revocation) and activates instantly — no .env edit, no
  redeploy. The key persists in the shared hulo_licence_store table and
  is re-applied on every boot; an explicitly configured env/init key
  always wins. POST licence/activate + licence/deactivate endpoints.

## [0.9.1] — 2026-08-21

### Added
- Evaluation pings now include anonymous usage aggregates (counts only,
  never personal data) so the opt-in reminder emails can say what the
  plugin actually did during the trial.

## [0.9.0] — 2026-08-21

### Added
- **14-day full-featured evaluation.** Unlicensed installs now get the
  complete feature set for 14 days instead of the restricted free tier.
  Scheduled sending now also runs during the evaluation window. The clock is anchored server-side (a hashed
  instance id — no personal data), so reinstalling does not restart it,
  and it fails open: if the licence server is unreachable the plugin
  keeps running fully. After the window the plugin drops to the free
  tier; all configuration is kept and reactivates instantly with a key.
- Admin-UI evaluation banner with live countdown and an optional
  "email me before it ends" reminder opt-in (explicit consent — no
  email is sent anywhere otherwise).

## [0.8.0] — 2026-08-04

### Added
- **Upload image / asset library.** A new toolbar button opens Vendure's
  asset picker — browse the library or upload a new image — and inserts it
  into the email. Images are stored in your Vendure asset library like any
  other asset. The previous insert-by-URL button stays. Editor selection
  is now saved/restored so toolbar and colour actions apply reliably even
  after a dialog opens.

## [0.7.0] — 2026-08-04

### Added
- **Full editor toolbar**: text + highlight colour, font size, underline/
  strikethrough, headings/subheadings/quotes, numbered lists, indent/
  outdent, image insert (by URL, alt text), a custom button, horizontal
  divider, left/centre/right align, clear-formatting and undo/redo.

### Fixed
- Editor text showed grey in dark mode: the admin theme was colouring
  bare block elements. Canvas content now forces its own dark ink on the
  white paper (inline colours in your HTML still win).

## [0.6.1] — 2026-08-04

### Fixed
- Dark mode: the visual editor canvas now reads as an intentional white
  "paper" (framed, with a visible caret + selection) instead of a bare
  white block, and the email preview renders on white to match how the
  email actually looks.

## [0.6.0] — 2026-08-04

### Added
- **Visual email editor.** The invitation email now has a WYSIWYG editor
  with a formatting toolbar (bold, italic, heading, lists, links, a
  one-click review button, alignment), **drag-and-drop variable chips**
  (drop {{firstName}}, {{productList}}, etc. anywhere), and a **Visual /
  HTML toggle** so you can drop into raw HTML whenever you want. Live
  preview + test-send unchanged.

## [0.5.0] — 2026-08-04

### Added
- **Product reviews.** A new "What to ask for" mode — Store review /
  Product reviews / Both. In product (or both) mode the email lists the
  actual products from the customer's order, each with its own "Review
  this" button linking to your storefront's product-review page (a
  configurable link template with {slug}, {name}, {orderCode}). Works
  alongside the Trustpilot/Google store review. New template variables
  {{reviewButton}} and {{productList}}.
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
