# DigitalApple Backend

## Barber booking (@handle)

A booking platform mounted inside this backend. It reuses the existing Stripe,
SMTP, Mongo and JWT credentials — nothing new to provision.

- `/@handle` — a barber's public booking page (the link that goes in their bio)
- `/book` — the barber's admin panel: diary, menu, hours, bills, payouts
- `/api/v1/barber/*` — the API behind both
- `/api/v1/barber/health` — which credentials are wired up, no secrets

Money runs on Stripe Connect. Clients pay once; the barber's connected account
receives the payment and the platform keeps `platformFeeBps` as an application
fee. The rate is per shop and adjustable by the platform owner. Payment state is
written only by the verified Stripe webhook (`/api/v1/tokens/webhook`).

Environment: see the barber block in `.env.example`.
Tests: `npm run test:barber` (unit + two end-to-end suites, 92 checks).
