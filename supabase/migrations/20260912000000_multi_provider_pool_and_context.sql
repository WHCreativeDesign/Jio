-- Multiple providers in one pool -----------------------------------------
-- Keys are no longer groq-only. Each key knows its provider; the proxy picks
-- from the provider the requested model belongs to.
alter table public.donated_keys
  add column provider text not null default 'groq'
    check (provider in ('groq', 'cohere', 'gemini', 'nvidia')),
  -- consecutive failures, so a key that keeps rate-limiting rests longer each
  -- time instead of being retried into the ground every minute
  add column fails integer not null default 0;

drop index if exists donated_keys_status_idx;
create index donated_keys_pick_idx on public.donated_keys (provider, status, last_used_at);

-- a healthy use clears the failure streak
create or replace function public.note_key_use(key_id uuid)
returns void language sql security definer set search_path = '' as $$
  update public.donated_keys
     set uses = uses + 1, last_used_at = now(), last_error = null, fails = 0
   where id = key_id;
$$;
revoke all on function public.note_key_use(uuid) from public, anon, authenticated;
grant execute on function public.note_key_use(uuid) to service_role;

-- Cooling. If the provider told us exactly how long to wait (Retry-After), honour
-- that and nothing more — resting a key longer than asked just wastes quota.
-- Without a hint, back off 1m, 2m, 5m, 15m on a failure streak.
create function public.cool_key(key_id uuid, message text, secs integer default null)
returns void language sql security definer set search_path = '' as $$
  update public.donated_keys
     set status = 'cooling',
         last_error = message,
         fails = fails + 1,
         cooling_until = now() + coalesce(
           make_interval(secs => least(greatest(secs, 1), 3600)),
           case least(fails, 3)
             when 0 then interval '1 minute'
             when 1 then interval '2 minutes'
             when 2 then interval '5 minutes'
             else interval '15 minutes'
           end
         )
   where id = key_id;
$$;
revoke all on function public.cool_key(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.cool_key(uuid, text, integer) to service_role;

-- the public mirror carries the provider so the pool page can show it
alter table public.pool_public add column provider text not null default 'groq';

create or replace function public.sync_pool_public()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (tg_op = 'DELETE') then
    delete from public.pool_public where key_id = old.id;
    return old;
  end if;
  insert into public.pool_public (key_id, donor, masked, status, uses, created_at, provider)
  values (
    new.id,
    coalesce((select p.handle from public.profiles p where p.id = new.owner), 'anon'),
    new.masked, new.status, new.uses, new.created_at, new.provider
  )
  on conflict (key_id) do update
    set masked = excluded.masked, status = excluded.status,
        uses = excluded.uses, provider = excluded.provider;
  return new;
end;
$$;
revoke all on function public.sync_pool_public() from public, anon, authenticated;

update public.pool_public p
   set provider = k.provider
  from public.donated_keys k
 where k.id = p.key_id;

-- Context compression ------------------------------------------------------
-- A long chat's older turns get folded into one dense summary so the payload
-- stops growing. Persisted here so reopening a chat doesn't pay to redo it.
alter table public.chats
  add column summary text,
  add column compressed_upto integer not null default 0;
