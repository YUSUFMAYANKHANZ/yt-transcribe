import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const app = express();
app.use(cors({ origin: process.env.APP_URL || true }));
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send('Stripe webhook is not configured.');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); }
  catch (error) { return res.status(400).send(`Webhook signature error: ${error.message}`); }
  const subscription = event.data.object;
  if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type)) {
    const userId = subscription.metadata?.user_id;
    if (userId && admin) {
      await admin.from('profiles').update({ subscription_status: subscription.status, subscription_ends_at: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null, stripe_customer_id: String(subscription.customer) }).eq('id', userId);
    }
  }
  res.json({ received: true });
});
app.use(express.json({ limit: '32kb' }));
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = supabaseUrl && serviceKey ? createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } }) : null;
const authClient = supabaseUrl && anonKey ? createClient(supabaseUrl, anonKey, { auth: { persistSession: false } }) : null;
const actorId = process.env.APIFY_ACTOR_ID?.trim() || 'johnvc~youtubetranscripts';
const apifyToken = process.env.APIFY_API_TOKEN?.trim();
const hasApifyToken = Boolean(apifyToken && !/^(your[-_ ]|placeholder|replace[-_ ]|<)/i.test(apifyToken));

function normalizeVideo(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  const raw = value.trim();
  if (/^[\w-]{11}$/.test(raw)) return `https://www.youtube.com/watch?v=${raw}`;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, '');
    if (!['youtube.com', 'youtube-nocookie.com', 'youtu.be'].includes(host)) return null;
    let id = host === 'youtu.be' ? url.pathname.split('/').filter(Boolean)[0] : url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?]+)/)?.[1];
    return id && /^[\w-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
  } catch { return null; }
}

async function requireUser(req, res, next) {
  if (!admin || !authClient) return res.status(503).json({ error: 'Supabase is not configured on the server.' });
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Sign in to continue.' });
  try {
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data.user || !data.user.email_confirmed_at) return res.status(401).json({ error: 'Please verify your email and sign in again.' });
    req.user = data.user;
    return next();
  } catch (error) {
    console.error('Supabase token verification failed:', error.message);
    return res.status(503).json({ error: 'Could not verify your session with Supabase. Please retry in a moment.' });
  }
}

app.get('/api/health', (_req, res) => res.json({ ok: true, configured: Boolean(admin && authClient && hasApifyToken), supabaseConfigured: Boolean(admin && authClient), apifyConfigured: hasApifyToken }));

app.post('/api/promo/claim', requireUser, async (req, res) => {
  try {
    const { data, error } = await admin.rpc('claim_seven_day_promo', { p_user_id: req.user.id });
    if (error) {
      console.error('Promo claim failed:', error.message);
      return res.status(500).json({ error: 'Could not activate the seven-day pass. Please try again.' });
    }
    const claim = Array.isArray(data) ? data[0] : data;
    if (!claim) return res.status(404).json({ error: 'Account profile was not found. Sign out and back in, then try again.' });
    if (!claim.claimed) {
      const active = claim.promo_ends_at && new Date(claim.promo_ends_at).getTime() > Date.now();
      return res.status(409).json({
        error: active
          ? 'Your seven-day pass has already been claimed and is active.'
          : 'Your one-time seven-day pass has already expired. You have one free transcript each day.',
        promo: claim
      });
    }
    return res.json({ promo: claim });
  } catch (error) {
    console.error('Promo claim request failed:', error.message);
    return res.status(503).json({ error: 'Could not reach your account. Please try again.' });
  }
});

app.post('/api/transcript', requireUser, async (req, res) => {
  const url = normalizeVideo(req.body?.url);
  const language = /^[a-z]{2,3}$/i.test(req.body?.language || '') ? req.body.language.toLowerCase() : 'en';
  if (!url) return res.status(400).json({ error: 'Enter a valid YouTube video URL or video ID.' });
  if (!hasApifyToken) return res.status(503).json({ error: 'Add your real APIFY_API_TOKEN in .env to enable transcript generation.' });

  // Reserve today's free credit atomically, before calling the paid Actor.
  const { data: allowed, error: creditError } = await admin.rpc('consume_daily_credit', { p_user_id: req.user.id });
  if (creditError) {
    console.error('Credit reservation failed:', creditError.message);
    return res.status(500).json({ error: 'Could not check your daily credit. Apply the Supabase schema and try again.' });
  }
  if (!allowed) return res.status(429).json({ error: 'Your free transcript for today has been used. Come back tomorrow or unlock the 7-day offer.' });

  try {
    const response = await fetch(`https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?timeout=180&memory=256`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apifyToken}` },
      body: JSON.stringify({ youtube_url: url, languages: [language], include_metadata: true, output_formats: [] }),
      signal: AbortSignal.timeout(190_000)
    });
    const rows = await response.json().catch(() => null);
    if (!response.ok) {
      const upstreamError = new Error(rows?.error?.message || rows?.error || rows?.message || `Apify returned ${response.status}.`);
      upstreamError.upstreamStatus = response.status;
      throw upstreamError;
    }
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row || row.success === false || row.error || row.status === 'error' || row.status === 'no_transcript') {
      const availableLanguages = Array.isArray(row?.available_transcripts)
        ? row.available_transcripts.map((item) => item.language_code || item.language).filter(Boolean)
        : [];
      const noCaptions = ['NoTranscriptFound', 'TranscriptsDisabled'].includes(row?.error_type) || /no transcript|no caption/i.test(row?.error_message || '');
      const detail = row?.error_message || (typeof row?.error === 'string' ? row.error : null) || row?.message;
      const error = new Error(noCaptions
        ? availableLanguages.length
          ? `No captions were found in ${language}. Available languages: ${[...new Set(availableLanguages)].join(', ')}.`
          : 'This video has no captions available in the selected language.'
        : detail || 'Apify could not retrieve this video transcript.');
      if (noCaptions) error.status = 422;
      throw error;
    }
    const transcriptText = row.non_timestamped || row.transcript || row.text || row.transcript_text || row.text_transcript || row.transcriptText || '';
    if (!transcriptText && Array.isArray(row.timestamped)) {
      row.non_timestamped = row.timestamped.map((segment) => segment.text).join(' ');
    }
    const cleanText = transcriptText || row.non_timestamped || '';
    if (!cleanText.trim()) throw new Error('This video did not return a transcript. Check that captions are available.');
    const record = { user_id: req.user.id, video_url: url, title: row.title || row.video_title || 'YouTube video', channel_name: row.channel_name || row.channel || null, video_duration_seconds: Number(row.video_duration_seconds || row.total_seconds || row.duration_seconds || 0) || null, thumbnail_url: row.thumbnail_url || row.thumbnail || null, language: row.language_code || language, transcript_text: cleanText, segments: Array.isArray(row.timestamped) ? row.timestamped : Array.isArray(row.segments) ? row.segments : [], word_count: cleanText.trim().split(/\s+/).length };
    const { data: saved, error: saveError } = await admin.from('transcripts').insert(record).select().single();
    if (saveError) throw new Error('Transcript generated but could not be saved to your history. Check the Supabase schema.');
    return res.json({ transcript: saved });
  } catch (error) {
    // Failed extractions should not consume the free daily allowance.
    try {
      const { error: refundError } = await admin.rpc('refund_daily_credit', { p_user_id: req.user.id });
      if (refundError) console.error('Credit refund failed:', refundError.message);
    } catch (refundError) {
      console.error('Credit refund failed:', refundError.message);
    }
    console.error('Transcript request failed:', error.message);
    const upstreamStatus = error.upstreamStatus;
    const status = error.status || (error.name === 'TimeoutError' ? 504 : 502);
    const message = error.name === 'TimeoutError' ? 'The transcript service took too long. Please try again.' : upstreamStatus === 401 || upstreamStatus === 403 ? 'Apify rejected its API token. Check APIFY_API_TOKEN in .env and restart the server.' : error.message || 'Transcript generation failed.';
    return res.status(status).json({ error: message });
  }
});

app.post('/api/checkout', requireUser, async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID) return res.status(503).json({ error: 'Stripe is not configured yet. Add STRIPE_SECRET_KEY and STRIPE_PRICE_ID in Vercel settings.' });
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const origin = process.env.APP_URL || req.headers.origin || 'http://localhost:5173';
    const checkout = await stripe.checkout.sessions.create({ mode: 'subscription', line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }], subscription_data: { trial_period_days: 7, metadata: { user_id: req.user.id } }, client_reference_id: req.user.id, customer_email: req.user.email, success_url: `${origin}/?billing=success`, cancel_url: `${origin}/?billing=cancelled` });
    res.json({ url: checkout.url });
  } catch (error) { console.error('Stripe checkout failed:', error.message); res.status(502).json({ error: 'Could not start checkout. Check your Stripe price configuration.' }); }
});

app.post('/api/billing-portal', requireUser, async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe is not configured yet.' });
  const { data: profile } = await admin.from('profiles').select('stripe_customer_id').eq('id', req.user.id).single();
  if (!profile?.stripe_customer_id) return res.status(404).json({ error: 'No Stripe billing profile is linked to this account.' });
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const origin = process.env.APP_URL || req.headers.origin || 'http://localhost:5173';
    const portal = await stripe.billingPortal.sessions.create({ customer: profile.stripe_customer_id, return_url: `${origin}/` });
    res.json({ url: portal.url });
  } catch (error) { console.error('Stripe billing portal failed:', error.message); res.status(502).json({ error: 'Could not open billing management.' }); }
});

app.get('/api/billing', requireUser, async (req, res) => {
  try {
    const { data, error } = await admin.from('profiles').select('subscription_status,subscription_ends_at,daily_credit_date,promo_claimed_at,promo_ends_at').eq('id', req.user.id).single();
    if (error) {
      console.error('Billing profile lookup failed:', error.message);
      return res.status(500).json({ error: 'Could not load billing details.' });
    }
    const promoEndsAt = data.promo_ends_at ? new Date(data.promo_ends_at).getTime() : 0;
    const promoActive = Boolean(data.promo_claimed_at && promoEndsAt > Date.now());
    return res.json({ billing: {
      ...data,
      promo_active: promoActive,
      promo_days_remaining: promoActive ? Math.ceil((promoEndsAt - Date.now()) / 86_400_000) : 0
    } });
  } catch (error) {
    console.error('Billing request failed:', error.message);
    return res.status(503).json({ error: 'Could not reach Supabase to load billing details.' });
  }
});

if (process.env.VERCEL !== '1') app.listen(Number(process.env.PORT || 3001), () => console.log(`Cliptext API listening on ${process.env.PORT || 3001}`));
export default app;
