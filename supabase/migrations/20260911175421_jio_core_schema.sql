-- profiles -------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  handle text not null,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

create policy "read own profile" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
create policy "update own profile" on public.profiles
  for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, handle)
  values (new.id, coalesce(new.raw_user_meta_data->>'handle', split_part(new.email, '@', 1)));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- donated keys ---------------------------------------------------------
create table public.donated_keys (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users on delete cascade,
  label text not null default 'my key',
  api_key text not null,
  masked text generated always as (left(api_key, 7) || '…' || right(api_key, 4)) stored,
  status text not null default 'ok' check (status in ('ok', 'cooling', 'dead')),
  uses integer not null default 0,
  last_error text,
  cooling_until timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  unique (api_key)
);
alter table public.donated_keys enable row level security;

-- owners manage their own rows; RLS keeps every other key unreadable
create policy "insert own key" on public.donated_keys
  for insert to authenticated with check ((select auth.uid()) = owner);
create policy "read own keys" on public.donated_keys
  for select to authenticated using ((select auth.uid()) = owner);
create policy "delete own keys" on public.donated_keys
  for delete to authenticated using ((select auth.uid()) = owner);

create index donated_keys_owner_idx on public.donated_keys (owner);
create index donated_keys_status_idx on public.donated_keys (status, last_used_at);

-- public pool view: masked only, never the raw key.
-- plain view (security_invoker off) so it can summarise rows RLS hides.
create view public.pool_public as
  select k.id, k.masked, k.status, k.uses, k.created_at, coalesce(p.handle, 'anon') as donor
  from public.donated_keys k
  left join public.profiles p on p.id = k.owner
  order by k.uses desc;

revoke all on public.pool_public from anon, authenticated;
grant select on public.pool_public to authenticated;

create view public.pool_stats as
  select count(*)::int as keys,
         count(*) filter (where status = 'ok')::int as healthy,
         coalesce(sum(uses), 0)::bigint as requests
  from public.donated_keys;

revoke all on public.pool_stats from anon, authenticated;
grant select on public.pool_stats to authenticated;

-- chats ----------------------------------------------------------------
create table public.chats (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users on delete cascade,
  title text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.chats enable row level security;

create policy "own chats" on public.chats
  for all to authenticated using ((select auth.uid()) = owner) with check ((select auth.uid()) = owner);
create index chats_owner_idx on public.chats (owner, updated_at desc);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats on delete cascade,
  owner uuid not null references auth.users on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null default '',
  created_at timestamptz not null default now()
);
alter table public.messages enable row level security;

create policy "own messages" on public.messages
  for all to authenticated using ((select auth.uid()) = owner) with check ((select auth.uid()) = owner);
create index messages_chat_idx on public.messages (chat_id, created_at);
