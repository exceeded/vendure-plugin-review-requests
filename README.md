# @huloglobal/vendure-plugin-review-requests

Automated post-purchase **review invitations** for [Vendure](https://www.vendure.io/),
timed off your order dates. Sends a branded, Trustpilot-style email that links to
your **free** Trustpilot review page — no paid Automatic Feedback Service required —
and can show your live star rating pulled from the free Trustpilot API.

**Plugin page & pricing:** https://huloglobal.com/vendure-plugins/review-requests/

## What it does

- **Timed off order dates.** An hourly worker finds orders that reached a trigger
  state (Delivered / Payment settled / Shipped) *N days ago* and invites the
  customer to review you.
- **Free Trustpilot, done right.** The review button links to
  `https://www.trustpilot.com/evaluate/<your-domain>` (organic Service Reviews,
  free). Optionally add a free Trustpilot developer API key and the email shows
  your live **TrustScore + review count** as social proof. The link template is
  configurable, so you can point at Google reviews or anywhere else instead.
- **Exclusions.** Never invite specific emails or whole domains (wholesale
  accounts, staff). One-click **unsubscribe** in every email auto-excludes.
- **No spam.** Deduped per order, plus a per-customer **cooldown** (default 120
  days) and a minimum order value.
- **Editable email** with live preview + test-send, per channel.
- **Multi-tab admin**: Overview (sent / eligible / opt-outs / failed, live
  rating), Settings, Email, Exclusions, Activity log.

## Install

```bash
npm i @huloglobal/vendure-plugin-review-requests
```

```ts
import { ReviewRequestPlugin } from '@huloglobal/vendure-plugin-review-requests';

plugins: [
    ReviewRequestPlugin.init({
        publicBaseUrl: 'https://shop.example.com',   // for unsubscribe links
        licenceKey: process.env.HULO_REVIEW_LICENCE,
    }),
],
```

Admin UI:

```ts
ReviewRequestPlugin.uiExtensions,   // in your compileUiExtensions extensions array
```

Then open **Review requests** in the admin, set your Trustpilot domain, timing and
email, hit **Send test**, and switch the channel on.


> **Since 0.15.2:** invitations need `publicBaseUrl` (the unsubscribe link);
> set `optOutSecret` to keep unsubscribe links valid across reinstalls
> (otherwise a per-install secret is generated and stored); the trigger
> matches orders at or beyond the chosen state within a 45-day window.
>
> **Since 0.15.3:** the email body may be up to 4 MB (the column is widened
> to MEDIUMTEXT on first boot) and the subject up to 255 characters — larger
> saves are refused with a `400` that says so. Skipped/failed audit rows
> older than 18 months are pruned monthly on the worker; sent rows are kept.

## Getting your Trustpilot bits (all free)

- **Review link** — nothing needed; it's just `evaluate/<your-domain>`.
- **Live rating (optional)** — register a free app at
  <https://developers.trustpilot.com/> for an **API key**, put it in Settings, and
  click *Check rating* (the plugin finds your business-unit id from the domain).

## Configuration (per channel)

| Setting | Default | Notes |
|---|---|---|
| Trigger state | Delivered | Delivered / Payment settled / Shipped |
| Delay (days) | 14 | days after the order date |
| Min order value | 0 | skip low-value orders |
| Cooldown (days) | 120 | don't re-ask the same customer |
| Max per run | 200 | hourly throttle |
| Review link template | Trustpilot evaluate URL | `{domain}` is substituted |

## Licensing

Free tier: configure, preview and test-send. **Scheduled sending requires a
licence** from https://huloglobal.com/vendure-plugins/review-requests/.

## Compatibility

Vendure `>=3.5 <4`. MySQL / MariaDB / PostgreSQL (every statement is checked
against PostgreSQL 17 and MariaDB by the corpus test in `tests/`). Tables are created on
boot. Sends via your SMTP (`SMTP_SERVER` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM`,
or pass `smtp` to `init()`).

## License

AGPL-3.0-or-later — commercial licences available from HULO Global.

## Buying a licence

Pick monthly or annual on the plugin's admin banner and click **Start 14-day free trial** (card required, nothing charged until day 15, cancel any time), or choose lifetime — checkout opens in a new tab and the key installs itself within a minute. You can also buy at https://elite.charity/licence/buy/vendure-plugin-review-requests and paste the emailed key into the admin.
