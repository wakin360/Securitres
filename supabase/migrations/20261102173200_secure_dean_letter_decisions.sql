drop policy if exists "deans_update_letter_decisions"
  on public.excuse_letters;

revoke update on public.excuse_letters from authenticated;
revoke update (status, dean_comment, decided_at, decided_by)
  on public.excuse_letters from authenticated;

create or replace function public.decide_excuse_letter(
  p_letter_id uuid,
  p_decision text,
  p_comment text default null
)
returns public.excuse_letters
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_letter public.excuse_letters;
begin
  if (select auth.uid()) is null
    or (select public.current_profile_role()) is distinct from 'dean'
  then
    raise exception 'Only an authenticated Dean can decide excuse letters.'
      using errcode = '42501';
  end if;

  if p_decision is null or p_decision not in ('approved', 'disapproved') then
    raise exception 'Decision must be approved or disapproved.'
      using errcode = '22023';
  end if;

  update public.excuse_letters as l
  set status = p_decision,
      dean_comment = nullif(pg_catalog.btrim(p_comment), ''),
      decided_at = pg_catalog.now(),
      decided_by = (select auth.uid())
  where l.id = p_letter_id
    and l.status = 'pending'
  returning l.* into updated_letter;

  if not found then
    raise exception 'Letter was not found or is no longer pending.'
      using errcode = 'P0001';
  end if;

  return updated_letter;
end;
$$;

alter function public.decide_excuse_letter(uuid, text, text) owner to postgres;
revoke all on function public.decide_excuse_letter(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.decide_excuse_letter(uuid, text, text)
  to authenticated;

comment on function public.decide_excuse_letter(uuid, text, text) is
  'Atomically records a pending-letter decision by an authenticated Dean. The existing status-change trigger writes the audit event.';
