drop view if exists public.pool_public;
drop view if exists public.pool_stats;

-- Public face of the pool. Holds no secret, so it can be read under plain RLS
-- instead of a security-definer view that reaches past it.
create table public.pool_public (
  key_id uuid primary key references public.donated_keys(id) on delete cascade,
  donor text not null default 'anon',
  masked text not null,
  status text not null,
  uses integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.pool_public enable row level security;

create policy "signed-in users can see the pool" on public.pool_public
  for select to authenticated using (true);

create function public.sync_pool_public()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (tg_op = 'DELETE') then
    delete from public.pool_public where key_id = old.id;
    return old;
  end if;
  insert into public.pool_public (key_id, donor, masked, status, uses, created_at)
  values (
    new.id,
    coalesce((select p.handle from public.profiles p where p.id = new.owner), 'anon'),
    new.masked, new.status, new.uses, new.created_at
  )
  on conflict (key_id) do update
    set masked = excluded.masked, status = excluded.status, uses = excluded.uses;
  return new;
end;
$$;

create trigger sync_pool_public_trg
  after insert or update or delete on public.donated_keys
  for each row execute function public.sync_pool_public();

-- these are internal: trigger-fired or service-role only, never callable from the API
revoke all on function public.sync_pool_public() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.note_key_use(uuid) from public, anon, authenticated;
grant execute on function public.note_key_use(uuid) to service_role;

-- backfill anything already donated
insert into public.pool_public (key_id, donor, masked, status, uses, created_at)
select k.id, coalesce(p.handle, 'anon'), k.masked, k.status, k.uses, k.created_at
from public.donated_keys k left join public.profiles p on p.id = k.owner
on conflict (key_id) do nothing;
