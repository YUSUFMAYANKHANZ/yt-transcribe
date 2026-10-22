-- Run this file in Supabase SQL Editor before using Cliptext.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  daily_credit_date date,
  subscription_status text not null default 'inactive',
  subscription_ends_at timestamptz,
  promo_claimed_at timestamptz,
  promo_ends_at timestamptz,
  stripe_customer_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.transcripts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  video_url text not null,
  title text,
  channel_name text,
  video_duration_seconds integer,
  thumbnail_url text,
  language text not null default 'en',
  transcript_text text not null,
  segments jsonb not null default '[]'::jsonb,
  word_count integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists transcripts_user_created_idx on public.transcripts(user_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.transcripts enable row level security;
drop policy if exists "Users read own profile" on public.profiles;
create policy "Users read own profile" on public.profiles for select to authenticated using ((select auth.uid()) = id);
drop policy if exists "Users read own transcripts" on public.transcripts;
create policy "Users read own transcripts" on public.transcripts for select to authenticated using ((select auth.uid()) = user_id);
-- Writes and credit checks are made only by the server using the service role.
revoke all on table public.profiles, public.transcripts from public, anon, authenticated;
grant select on table public.profiles, public.transcripts to authenticated;
grant all on table public.profiles, public.transcripts to service_role;

create or replace function public.create_profile_for_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created_cliptext on auth.users;
create trigger on_auth_user_created_cliptext after insert or update of email on auth.users
for each row execute function public.create_profile_for_user();
revoke all on function public.create_profile_for_user() from public, anon, authenticated;
grant execute on function public.create_profile_for_user() to service_role;

-- Ensure profiles exist for accounts created before this schema was installed.
insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do update set email = excluded.email;

create or replace function public.consume_daily_credit(p_user_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare claimed boolean;
declare affected integer;
begin
  update public.profiles set daily_credit_date = (now() at time zone 'utc')::date
  where id = p_user_id and subscription_status not in ('active', 'trialing')
    and (promo_ends_at is null or promo_ends_at <= now())
    and (daily_credit_date is null or daily_credit_date < (now() at time zone 'utc')::date);
  get diagnostics affected = row_count;
  claimed := affected > 0;
  if not claimed then
    return exists(select 1 from public.profiles where id = p_user_id and (subscription_status in ('active', 'trialing') or promo_ends_at > now()));
  end if;
  return claimed;
end;
$$;
create or replace function public.refund_daily_credit(p_user_id uuid)
returns void language sql security definer set search_path = '' as $$
  update public.profiles set daily_credit_date = null
  where id = p_user_id and daily_credit_date = (now() at time zone 'utc')::date;
$$;
revoke all on function public.consume_daily_credit(uuid) from public, anon, authenticated;
revoke all on function public.refund_daily_credit(uuid) from public, anon, authenticated;
grant execute on function public.consume_daily_credit(uuid) to service_role;
grant execute on function public.refund_daily_credit(uuid) to service_role;

create or replace function public.claim_seven_day_promo(p_user_id uuid)
returns table (claimed boolean, promo_claimed_at timestamptz, promo_ends_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  claimed_profile public.profiles%rowtype;
begin
  update public.profiles as profile
  set promo_claimed_at = statement_timestamp(),
      promo_ends_at = statement_timestamp() + interval '7 days'
  where profile.id = p_user_id and profile.promo_claimed_at is null
  returning profile.* into claimed_profile;

  if found then
    return query select true, claimed_profile.promo_claimed_at, claimed_profile.promo_ends_at;
    return;
  end if;

  return query select false, profile.promo_claimed_at, profile.promo_ends_at
  from public.profiles as profile where profile.id = p_user_id;
end;
$$;
revoke all on function public.claim_seven_day_promo(uuid) from public, anon, authenticated;
grant execute on function public.claim_seven_day_promo(uuid) to service_role;
