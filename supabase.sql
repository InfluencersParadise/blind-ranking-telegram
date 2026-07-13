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
