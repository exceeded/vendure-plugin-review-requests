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

Vendure `>=3.5 <4`. MySQL / MariaDB. Tables are created on boot. Sends via your
SMTP (`SMTP_SERVER` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM`,
or pass `smtp` to `init()`).

## License

AGPL-3.0-or-later — commercial licences available from HULO Global.

## Buying a licence

Click **Buy licence** in the plugin's admin page (evaluation or free-tier banner), pick monthly, annual or lifetime, and complete checkout in the new tab — the key installs itself within a minute. You can also buy at https://elite.charity/licence/buy/vendure-plugin-review-requests and paste the emailed key into the admin.
