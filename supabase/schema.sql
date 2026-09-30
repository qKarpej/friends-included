-- Friends Included Ltd — Supabase schema.
-- Paste into Supabase → SQL Editor → Run. Safe to run again (idempotent).
-- Row Level Security is enabled with NO policies: the public anon key can read
-- nothing. Only the server (service-role key in Vercel env vars) can access data.

create table if not exists employees (
  id                text primary key,
  name              text not null,
  short             text not null,
  role              text not null check (role in ('manager', 'sales', 'expenses')),
  title             text not null,
  sort_order        int  not null default 0,
  telegram_user_id  text unique,          -- one Telegram account ↔ at most one employee
  telegram_chat_id  text
);

insert into employees (id, name, short, role, title, sort_order) values
  ('svetlana',   'Svetlana de Monte Carlo',         'Svetlana',    'manager',  'Manager',          1),
  ('richard',    'Richard “Call Me Dick” Darling',  'Richard',     'sales',    'Salesperson',      2),
  ('anastasia',  'Anastasia Ferrari',               'Anastasia',   'sales',    'Salesperson',      3),
  ('jeanclaude', 'Jean-Claude Bērziņš',             'Jean-Claude', 'sales',    'Salesperson',      4),
  ('kevin',      'Kevin von Whatever',              'Kevin',       'expenses', 'Expense reporter', 5)
on conflict (id) do nothing;

-- Everyone who has pressed /start in the bot (so the manager can link them from a list).
create table if not exists telegram_users (
  user_id     text primary key,
  chat_id     text not null,
  username    text,
  first_name  text,
  last_seen   timestamptz not null default now()
);

-- Telegram may re-deliver a webhook; each update is processed once.
create table if not exists telegram_updates (
  update_id    bigint primary key,
  received_at  timestamptz not null default now()
);

create table if not exists transactions (
  reference            text primary key,                         -- unique across sales AND expenses
  kind                 text not null check (kind in ('sale', 'expense')),
  submitted_by         text not null references employees(id),
  source               text not null check (source in ('telegram', 'web')),
  submitted_at         timestamptz not null default now(),
  description          text not null,
  amount               numeric(12,2) not null check (amount > 0),

  -- sales
  customer             text,
  project              text check (project in ('A', 'B')),
  prop_richard         numeric(5,2), prop_anastasia numeric(5,2), prop_jeanclaude numeric(5,2),   -- original proposal
  appr_richard         numeric(5,2), appr_anastasia numeric(5,2), appr_jeanclaude numeric(5,2),   -- manager's final split
  commission_pool      numeric(12,2),
  comm_richard         numeric(12,2), comm_anastasia numeric(12,2), comm_jeanclaude numeric(12,2),

  -- expenses
  category             text check (category in ('Materials', 'Travel', 'Other')),
  proposed_allocation  text check (proposed_allocation in ('A', 'B', 'OVERHEAD')),
  final_allocation     text check (final_allocation in ('A', 'B', 'OVERHEAD')),

  status               text not null check (status in ('pending', 'approved', 'awaiting_allocation', 'allocated')),
  decided_by           text references employees(id),
  decided_at           timestamptz,
  changed              boolean,

  -- delivery bookkeeping, kept separate from the financial decision
  origin_chat_id       text,          -- Telegram chat that submitted it (bot entries)
  notify_status        text,          -- awaiting_decision | pending | sent | failed | no_recipient | not_required
  notify_chat_id       text,
  notify_text          text,
  notify_error         text,
  notified_at          timestamptz,
  sheet_status         text,          -- pending | synced | failed
  sheet_error          text,
  sheet_row            text,
  sheet_synced_at      timestamptz,

  constraint sale_fields check (kind <> 'sale' or (customer is not null and project is not null
    and prop_richard + prop_anastasia + prop_jeanclaude = 100)),
  constraint expense_fields check (kind <> 'expense' or (category is not null and proposed_allocation is not null)),
  constraint approved_split check (status <> 'approved' or appr_richard + appr_anastasia + appr_jeanclaude = 100),
  constraint commission_adds_up check (status <> 'approved' or comm_richard + comm_anastasia + comm_jeanclaude = commission_pool)
);

-- Case-insensitive uniqueness: "s01" cannot sneak in next to "S01".
create unique index if not exists transactions_reference_ci on transactions (upper(reference));

-- Append-only, hash-chained audit ledger (see lib/ledger.js).
create table if not exists audit_log (
  seq        bigint primary key,
  prev_hash  text not null,
  hash       text not null unique,
  at         text not null,
  actor      text,
  action     text not null,
  reference  text,
  details    text
);

create table if not exists app_settings (
  key    text primary key,
  value  jsonb not null
);

alter table employees        enable row level security;
alter table telegram_users   enable row level security;
alter table telegram_updates enable row level security;
alter table transactions     enable row level security;
alter table audit_log        enable row level security;
alter table app_settings     enable row level security;
