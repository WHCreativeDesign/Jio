create function public.note_key_use(key_id uuid)
returns void language sql security definer set search_path = '' as $$
  update public.donated_keys
     set uses = uses + 1, last_used_at = now(), last_error = null
   where id = key_id;
$$;

revoke all on function public.note_key_use(uuid) from anon, authenticated;
