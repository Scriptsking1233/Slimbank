-- =====================================================================
-- SlimBANK - схема базы данных для Supabase (PostgreSQL)
-- Запустить один раз в Supabase -> SQL Editor -> New query -> Run
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. Профили игроков (1 строка = 1 аккаунт SlimBANK)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  login_id      text not null unique,            -- цифры телефона, он же id аккаунта в игре
  phone         text,
  email         text,
  username      text unique,                     -- общий для всех игроков уникальный юзернейм
  first_name    text,
  last_name     text,
  city          text,
  birth         text,
  plan          text not null default 'basic',
  balance       numeric(40,2) not null default 0,
  last_accrual  bigint not null default 0,       -- unix ms последнего начисления
  state         jsonb not null default '{}'::jsonb,  -- всё остальное: карта, бизнесы, подарки...
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_profiles_balance on public.profiles (balance desc);

alter table public.profiles enable row level security;

drop policy if exists profiles_select_own on public.profiles;
drop policy if exists profiles_insert_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;

-- каждый видит и меняет только свой профиль
create policy profiles_select_own on public.profiles
  for select using (auth.uid() = id);
create policy profiles_insert_own on public.profiles
  for insert with check (auth.uid() = id);
create policy profiles_update_own on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- updated_at сам обновляется
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_profiles_touch on public.profiles;
create trigger trg_profiles_touch
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- 2. Логин по телефону / e-mail / @юзернейму
--    Возвращает служебный e-mail, с которым заведён аккаунт в auth
-- ---------------------------------------------------------------------
create or replace function public.find_login(p_login text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_login text;
  v_digits text;
begin
  v_digits := regexp_replace(coalesce(p_login, ''), '[^0-9]', '', 'g');
  select login_id into v_login
    from profiles
   where (v_digits <> '' and login_id = v_digits)
      or (p_login is not null and email is not null and lower(email) = lower(p_login))
      or (p_login is not null and username is not null and lower(username) = lower(ltrim(p_login, '@')))
   limit 1;
  if v_login is null then
    return null;
  end if;
  return v_login || '@slimbank.local';
end $$;

grant execute on function public.find_login(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Свободен ли юзернейм (общая проверка для всех игроков)
-- ---------------------------------------------------------------------
create or replace function public.username_free(p_name text)
returns boolean
language sql security definer set search_path = public as $$
  select not exists (
    select 1 from profiles where lower(username) = lower(ltrim(coalesce(p_name, ''), '@'))
  );
$$;

grant execute on function public.username_free(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Закрепить юзернейм за собой (атомарно, без гонок)
-- ---------------------------------------------------------------------
create or replace function public.claim_username(p_name text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  nm text := ltrim(coalesce(p_name, ''), '@');
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  if nm !~ '^[A-Za-z0-9_]{4,20}$' then
    return jsonb_build_object('ok', false, 'error', 'format');
  end if;
  update profiles set username = nm where id = uid;
  return jsonb_build_object('ok', true, 'username', nm);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'error', 'taken');
end $$;

grant execute on function public.claim_username(text) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Топ игроков (без персональных данных)
-- ---------------------------------------------------------------------
create or replace function public.leaderboard(p_limit int default 20)
returns table (place bigint, username text, first_name text, plan text, balance numeric)
language sql security definer set search_path = public as $$
  select row_number() over (order by balance desc) as place,
         coalesce(username, 'slim' || left(login_id, 4)) as username,
         first_name, plan, balance
    from profiles
   order by balance desc
   limit least(coalesce(p_limit, 20), 100);
$$;

grant execute on function public.leaderboard(int) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. Начисления по тарифу — считает СЕРВЕР (каждые 10 минут)
-- ---------------------------------------------------------------------
create table if not exists public.plans (
  key     text primary key,
  name    text not null,
  accrual numeric(20,2) not null
);

insert into public.plans (key, name, accrual) values
  ('basic',    'Slim Basic',    25),
  ('plus',     'Slim Plus',     90),
  ('platinum', 'Slim Platinum', 260),
  ('black',    'Slim Black',    900),
  ('infinite', 'Slim Infinite', 3200)
on conflict (key) do update set name = excluded.name, accrual = excluded.accrual;

alter table public.plans enable row level security;
drop policy if exists plans_read on public.plans;
create policy plans_read on public.plans for select using (true);

-- начислить всё, что накапало с прошлого раза (максимум за 48 часов офлайна)
create or replace function public.claim_accruals()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  p profiles;
  rate numeric;
  now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  periods int;
  gained numeric;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  select * into p from profiles where id = uid;
  if p.id is null then
    return jsonb_build_object('ok', false, 'error', 'no_profile');
  end if;
  select accrual into rate from plans where key = p.plan;
  rate := coalesce(rate, 25);

  if p.last_accrual = 0 then
    update profiles set last_accrual = now_ms where id = uid;
    return jsonb_build_object('ok', true, 'gained', 0, 'balance', p.balance);
  end if;

  periods := floor((now_ms - p.last_accrual) / 600000.0);
  if periods < 1 then
    return jsonb_build_object('ok', true, 'gained', 0, 'balance', p.balance);
  end if;
  periods := least(periods, 288);  -- не больше 48 часов
  gained := rate * periods;

  update profiles
     set balance = balance + gained,
         last_accrual = p.last_accrual + periods::bigint * 600000
   where id = uid;

  return jsonb_build_object('ok', true, 'gained', gained, 'periods', periods,
                            'balance', p.balance + gained);
end $$;

grant execute on function public.claim_accruals() to authenticated;

-- ---------------------------------------------------------------------
-- 7. Промокоды — проверяет и начисляет СЕРВЕР, один код = один раз
-- ---------------------------------------------------------------------
create table if not exists public.promo_codes (
  code     text primary key,
  title    text not null,
  note     text,
  money    numeric(40,2) not null default 0,
  gift     text,
  score    int not null default 0,
  max_uses int,
  uses     int not null default 0,
  active   boolean not null default true
);

create table if not exists public.promo_redemptions (
  user_id uuid not null references auth.users (id) on delete cascade,
  code    text not null references public.promo_codes (code) on delete cascade,
  ts      timestamptz not null default now(),
  primary key (user_id, code)
);

alter table public.promo_codes enable row level security;
alter table public.promo_redemptions enable row level security;

drop policy if exists promo_codes_read on public.promo_codes;
drop policy if exists promo_red_own on public.promo_redemptions;
create policy promo_codes_read on public.promo_codes for select using (active);
create policy promo_red_own on public.promo_redemptions for select using (auth.uid() = user_id);

insert into public.promo_codes (code, title, note, money, gift, score, max_uses) values
  ('WTHJW',     'Секретный код',      '100 квадриллионов ₽ на баланс', 100000000000000000, null, 0, null),
  ('SLIM2026',  'Стартовый бонус',   '500 000 ₽ на развитие',              500000, null, 0, null),
  ('LUCKY777',  'Семёрки',            '7 777 777 ₽ на игру',               7777777, null, 0, null),
  ('GRAM888',   'GRAM акция',          '88 888 888 ₽ на счёт',             88888888, null, 0, null),
  ('BEARHUG',   'Мишка в подарок',   'Подарок «Мишка» в профиль',              0, 'bear', 0, null),
  ('CREDITFIX', 'Ремонт скоринга',   '+90 баллов кредитного рейтинга',        0, null, 90, null)
on conflict (code) do nothing;

create or replace function public.redeem_promo(p_code text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  c promo_codes;
  new_balance numeric;
  clean text;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  clean := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  select * into c from promo_codes where code = clean and active;
  if c.code is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if c.max_uses is not null and c.uses >= c.max_uses then
    return jsonb_build_object('ok', false, 'error', 'limit');
  end if;

  insert into promo_redemptions (user_id, code) values (uid, c.code);
  update promo_codes set uses = uses + 1 where code = c.code;
  update profiles set balance = balance + c.money where id = uid
    returning balance into new_balance;

  return jsonb_build_object('ok', true, 'code', c.code, 'title', c.title, 'note', c.note,
                            'money', c.money, 'gift', c.gift, 'score', c.score,
                            'balance', new_balance);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'error', 'used');
end $$;

grant execute on function public.redeem_promo(text) to authenticated;

-- ---------------------------------------------------------------------
-- 8. Защита от грубой накрутки баланса (логирование рывков)
--    Полный античит = перенос игровой логики в RPC (второй этап)
-- ---------------------------------------------------------------------
create table if not exists public.audit_log (
  id      bigserial primary key,
  user_id uuid,
  kind    text not null,
  detail  jsonb,
  ts      timestamptz not null default now()
);

alter table public.audit_log enable row level security;  -- читать можно только из консоли Supabase

create or replace function public.guard_balance()
returns trigger language plpgsql as $$
declare
  jump numeric := new.balance - old.balance;
begin
  if jump > 1000000000000000000 then   -- рывок больше 1 квинтиллиона за одно обновление
    insert into audit_log (user_id, kind, detail)
    values (new.id, 'balance_jump', jsonb_build_object('from', old.balance, 'to', new.balance));
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_balance on public.profiles;
create trigger trg_guard_balance
  before update of balance on public.profiles
  for each row execute function public.guard_balance();

-- Готово. Дальше: Authentication -> Providers -> Email -> выключить "Confirm email".
