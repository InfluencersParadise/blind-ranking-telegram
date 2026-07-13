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
  position integer not null,
  created_at timestamptz not null default now(),
  unique(category_id, position)
);

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
  updated_at timestamptz not null default now()
);

alter table categories enable row level security;
alter table items enable row level security;
alter table app_settings enable row level security;
alter table admin_sessions enable row level security;
-- Die App greift ausschließlich serverseitig mit dem Service-Role-Key zu.

insert into storage.buckets (id, name, public)
values ('blind-ranking-images', 'blind-ranking-images', true)
on conflict (id) do update set public = true;
