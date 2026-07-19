create extension if not exists pgcrypto;

create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_by bigint not null,
  created_at timestamptz not null default now()
);

create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references categories(id) on delete cascade,
  title text not null,
  image_url text not null,
  storage_path text,
  position integer not null,
  created_at timestamptz not null default now(),
  unique(category_id, position)
);

alter table items add column if not exists storage_path text;

create table if not exists app_settings (
  id integer primary key check (id = 1),
  active_category_id uuid references categories(id) on delete set null
);
insert into app_settings(id) values (1) on conflict (id) do nothing;

create table if not exists admin_sessions (
  user_id bigint primary key,
  category_id uuid references categories(id) on delete cascade,
  mode text not null default 'awaiting_photo',
  pending_file_id text,
  pending_item_id uuid references items(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table admin_sessions add column if not exists pending_item_id uuid references items(id) on delete set null;

alter table categories enable row level security;
alter table items enable row level security;
alter table app_settings enable row level security;
alter table admin_sessions enable row level security;

insert into storage.buckets (id, name, public)
values ('blind-ranking-images', 'blind-ranking-images', true)
on conflict (id) do update set public = true;


-- Version 2.2: Ausgabe-Einstellungen und Abstimmungsverteilung
alter table categories add column if not exists send_images boolean not null default true;

create table if not exists game_votes (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references categories(id) on delete cascade,
  chat_id bigint not null,
  user_id bigint not null,
  player_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(category_id, chat_id, user_id)
);

create table if not exists vote_entries (
  vote_id uuid not null references game_votes(id) on delete cascade,
  item_id uuid not null references items(id) on delete cascade,
  position integer not null check (position > 0),
  primary key(vote_id, item_id),
  unique(vote_id, position)
);

alter table game_votes enable row level security;
alter table vote_entries enable row level security;

-- Version 2.8: getrennte Telegram-Forenthemen für Umfrage-Link und Ergebnisse
create table if not exists group_topic_settings (
  chat_id bigint primary key,
  poll_thread_id bigint,
  results_thread_id bigint,
  updated_at timestamptz not null default now()
);

alter table group_topic_settings enable row level security;


-- Version 3.0: Rollen- und Tokenverwaltung
create table if not exists bot_users (
  user_id bigint primary key,
  role text not null check (role in ('owner','creator','player')),
  username text,
  display_name text,
  active boolean not null default true,
  approved_by bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists invite_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  token_hint text not null,
  role text not null check (role in ('creator','player')),
  created_by bigint not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  used_by bigint,
  used_at timestamptz,
  revoked_at timestamptz
);

alter table bot_users enable row level security;
alter table invite_tokens enable row level security;

-- Version 3.1: Player sind öffentlich; Creator erhalten Kategorienkontingente
alter table bot_users add column if not exists category_limit integer check (category_limit is null or category_limit > 0);
alter table bot_users add column if not exists categories_used integer not null default 0 check (categories_used >= 0);
alter table invite_tokens add column if not exists category_limit integer check (category_limit is null or category_limit > 0);

-- Bestehende aktive Creator werden aus Kompatibilitätsgründen unbegrenzt geführt.
update bot_users
set category_limit = null,
    categories_used = greatest(categories_used, (
      select count(*)::integer from categories where categories.created_by = bot_users.user_id
    ))
where role = 'creator';

-- Alte Player-Freigaben werden nicht mehr benötigt; Player sind automatisch alle Nutzer.
update bot_users set active = false where role = 'player';

-- Version 3.4: Zusätzliche Owner können über bot_users mit role='owner' gespeichert werden.
-- Die bestehende Rollenprüfung erlaubt 'owner' bereits; keine destruktive Migration nötig.


-- Version 3.7: mehrere Spieltypen
alter table categories add column if not exists game_type text not null default 'blind_ranking' check (game_type in ('blind_ranking','fmk'));
create index if not exists categories_game_type_idx on categories(game_type);
