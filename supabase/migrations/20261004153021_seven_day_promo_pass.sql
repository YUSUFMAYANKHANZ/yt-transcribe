alter table public.profiles
  add column if not exists promo_claimed_at timestamptz,
  add column if not exists promo_ends_at timestamptz;

create or replace function public.claim_seven_day_promo(p_user_id uuid)
returns table (
  claimed boolean,
  promo_claimed_at timestamptz,
  promo_ends_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed_profile public.profiles%rowtype;
begin
  update public.profiles as profile
  set promo_claimed_at = statement_timestamp(),
      promo_ends_at = statement_timestamp() + interval '7 days'
  where profile.id = p_user_id
    and profile.promo_claimed_at is null
  returning profile.* into claimed_profile;

  if found then
    return query select true, claimed_profile.promo_claimed_at, claimed_profile.promo_ends_at;
    return;
  end if;

  return query
  select false, profile.promo_claimed_at, profile.promo_ends_at
  from public.profiles as profile
  where profile.id = p_user_id;
end;
$$;

revoke all on function public.claim_seven_day_promo(uuid) from public, anon, authenticated;
grant execute on function public.claim_seven_day_promo(uuid) to service_role;

create or replace function public.consume_daily_credit(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed boolean;
  affected integer;
begin
  update public.profiles
  set daily_credit_date = (now() at time zone 'utc')::date
  where id = p_user_id
    and subscription_status not in ('active', 'trialing')
    and (promo_ends_at is null or promo_ends_at <= now())
    and (daily_credit_date is null or daily_credit_date < (now() at time zone 'utc')::date);

  get diagnostics affected = row_count;
  claimed := affected > 0;
  if not claimed then
    return exists (
      select 1 from public.profiles
      where id = p_user_id
        and (
          subscription_status in ('active', 'trialing')
          or promo_ends_at > now()
        )
    );
  end if;

  return claimed;
end;
$$;
