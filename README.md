# Cliptext — YouTube Transcript Studio

A React single-page app backed by Supabase Auth/Postgres, an Express API, Apify's `johnvc/youtubetranscripts` actor, and optional Stripe subscription management. Eligible accounts can claim one free seven-day unlimited pass; after it expires, the daily free transcript limit applies again. This pass does not require a card or start a recurring Stripe charge. The Apify actor supports video URLs, Shorts, and video IDs; the app requests one transcript at a time, preferring the language selected in the interface.

## Requirements

- Node.js 20.19+ (required by Vite 7)
- A Supabase project
- An Apify account and API token
- Optional: a Stripe account for paid subscription management

## Local setup

1. Copy `.env.example` to `.env`, fill in the Supabase settings, and add your Apify API token to `APIFY_API_TOKEN`. The `VITE_` Supabase URL and anon/publishable key are intended to be visible in browser bundles; Supabase RLS protects user data. Keep `SUPABASE_SERVICE_ROLE_KEY`, `APIFY_API_TOKEN`, and Stripe credentials server-only, and never add the `VITE_` prefix to them.
2. For a new Supabase project, run [`supabase/schema.sql`](supabase/schema.sql). For an existing project, apply the migrations in `supabase/migrations`; the seven-day pass migration is already applied to the connected project.
3. In Supabase Authentication settings, configure the site URL and email confirmation redirect URL for your local app (`http://localhost:5173`) and deployed Vercel domain.
4. Install and run:

   ```sh
   npm install
   npm run dev
   ```

   Vite serves the app on port 5173 and proxies `/api` to the Express server on port 3001.

## Environment variables

| Variable | Used by | Purpose |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Browser | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Browser | Supabase public anon/publishable key; RLS is required |
| `SUPABASE_URL` | Server | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only | Server-side profile and transcript access |
| `APIFY_API_TOKEN` | Server only | Starts the Apify transcript actor |
| `APIFY_ACTOR_ID` | Server only | Apify Actor to run; defaults to `johnvc~youtubetranscripts` |
| `STRIPE_SECRET_KEY` | Server only | Creates Stripe Checkout sessions |
| `STRIPE_PRICE_ID` | Server only | Recurring price for optional Stripe Checkout sessions |
| `STRIPE_WEBHOOK_SECRET` | Server only | Verifies Stripe subscription events |
| `APP_URL` | Server | Public app URL used for CORS and Checkout redirects |

The `.env` file is ignored by Git. Use Vercel Project Settings → Environment Variables for deployed secrets; add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` there too, then redeploy so Vite can embed the public Supabase config.

## Optional Stripe subscription management

The free seven-day pass is handled separately in Supabase and never starts Stripe billing. For accounts that already have a Stripe subscription, set `STRIPE_SECRET_KEY` and enable the Stripe Customer Portal. Add a webhook endpoint at `https://YOUR_DOMAIN/api/stripe/webhook`, subscribe to `customer.subscription.created`, `customer.subscription.updated`, and `customer.subscription.deleted`, then set `STRIPE_WEBHOOK_SECRET`. The verified webhook updates paid subscription entitlements, and the account panel links active customers to the billing portal.

## Vercel deployment

Import this repository in Vercel, use the default Vite build settings (also declared in `vercel.json`), configure all environment variables, run the Supabase schema, and add your production domain to Supabase Auth redirect URLs and `APP_URL`. The `api/index.js` function exports the same Express routes used locally.

## Security notes

- Supabase Auth validates the user's bearer token server-side; verified email is required before transcript generation.
- The service-role and Apify tokens are read only in the Node API and never included in the Vite client bundle.
- Row-level security permits users to read only their own profile and transcript history. Writes and daily-credit reservation go through the server.
- A successful transcript consumes the user's one daily free credit; failed transcript requests refund the reservation. The one-time promo claim is atomically recorded in Supabase and expires after seven days.
- The selected Apify actor returns captions/transcripts that are available for a video; videos without captions may not have a transcript to return.
