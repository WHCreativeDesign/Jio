-- Durable, user-level memory: the small set of things jio should carry
-- between chats, so a turn can be cheap without being amnesiac. Deliberately
-- rows rather than one blob, so a single fact can be revised or dropped
-- (by jio or by hand) without rewriting the rest.
create table public.memories (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users on delete cascade,
  text text not null check (length(text) between 1 and 240),
  source text not null default 'jio' check (source in ('jio', 'you')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.memories enable row level security;
create policy "own memories" on public.memories
  for all to authenticated using ((select auth.uid()) = owner) with check ((select auth.uid()) = owner);
create index memories_owner_idx on public.memories (owner, created_at);
