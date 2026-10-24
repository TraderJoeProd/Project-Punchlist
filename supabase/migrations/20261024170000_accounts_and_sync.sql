-- Punchlist v2: accounts (admin / vendor), invite codes, cloud data, cc + notifications.
-- Every public table has RLS. SECURITY DEFINER code lives in the unexposed "private" schema;
-- the public RPCs are thin SECURITY INVOKER wrappers around it.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- ============ tables ============
create table public.profiles (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid unique references auth.users (id) on delete set null,
  display_name   text not null check (length(btrim(display_name)) > 0),
  role           text not null check (role in ('admin', 'vendor')),
  vendor_company text,
  created_at     timestamptz not null default now()
);

create table public.invite_codes (
  code        text primary key,
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '30 days',
  used_at     timestamptz,
  used_by     uuid,
  used_email  text
);
create index invite_codes_profile_id_idx on public.invite_codes (profile_id);

create table public.companies (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) > 0),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);

create table public.addresses (
  id         uuid primary key default gen_random_uuid(),
  address    text not null check (length(btrim(address)) > 0),
  nicknames  text[] not null default '{}',
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);

create table public.punchlists (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  address_id uuid not null references public.addresses (id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  unique (company_id, address_id)
);
create index punchlists_address_id_idx on public.punchlists (address_id);

create table public.items (
  id           uuid primary key default gen_random_uuid(),
  punchlist_id uuid not null references public.punchlists (id) on delete cascade,
  text         text not null check (length(btrim(text)) > 0),
  done         boolean not null default false,
  done_at      timestamptz,
  done_by      uuid references public.profiles (id) on delete set null,
  assignee_id  uuid references public.profiles (id) on delete set null,
  source       text not null default 'manual' check (source in ('manual', 'scan', 'import')),
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid()
);
create index items_punchlist_id_idx on public.items (punchlist_id);
create index items_assignee_id_idx on public.items (assignee_id);
create index items_done_by_idx on public.items (done_by);

create table public.item_ccs (
  item_id    uuid not null references public.items (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (item_id, profile_id)
);
create index item_ccs_profile_id_idx on public.item_ccs (profile_id);

create table public.notifications (
  id         bigint generated always as identity primary key,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  item_id    uuid references public.items (id) on delete cascade,
  kind       text not null check (kind in ('completed', 'assigned', 'cc')),
  message    text not null,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index notifications_profile_created_idx on public.notifications (profile_id, created_at desc);
create index notifications_item_id_idx on public.notifications (item_id);

-- Nobody signed-out gets anything; signed-in access is decided by RLS below.
revoke all on public.profiles, public.invite_codes, public.companies, public.addresses,
              public.punchlists, public.items, public.item_ccs, public.notifications from anon;
-- Codes are only made / redeemed through the RPCs.
revoke insert, update on public.invite_codes from authenticated;
-- Users may only flip read_at on their own notifications.
revoke insert, update on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;

-- ============ helper functions (private, security definer) ============
create function private.my_profile_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.profiles where user_id = (select auth.uid())
$$;

create function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where user_id = (select auth.uid()) and role = 'admin')
$$;

-- Items a vendor is cc'd on.
create function private.my_cc_item_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select c.item_id from public.item_ccs c
  join public.profiles p on p.id = c.profile_id
  where p.user_id = (select auth.uid())
$$;

-- Items assigned to the caller.
create function private.my_assigned_item_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select i.id from public.items i
  join public.profiles p on p.id = i.assignee_id
  where p.user_id = (select auth.uid())
$$;

-- Punchlists / companies / addresses a vendor can see (because an item there is theirs or they are cc'd).
create function private.my_punchlist_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct i.punchlist_id from public.items i
  where i.id in (select private.my_assigned_item_ids() union select private.my_cc_item_ids())
$$;

create function private.my_company_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct company_id from public.punchlists where id in (select private.my_punchlist_ids())
$$;

create function private.my_address_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct address_id from public.punchlists where id in (select private.my_punchlist_ids())
$$;

-- Profiles a vendor can see: themself, the assignee of items they are cc'd on,
-- and the people cc'd on their own items.
create function private.my_visible_profile_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select private.my_profile_id()
  union
  select i.assignee_id from public.items i where i.id in (select private.my_cc_item_ids()) and i.assignee_id is not null
  union
  select c.profile_id from public.item_ccs c where c.item_id in (select private.my_assigned_item_ids())
$$;

create function private.new_invite_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- 32 chars, no 0/O/1/I
  b bytea := extensions.gen_random_bytes(8);
  s text := '';
begin
  for i in 0..7 loop
    s := s || substr(alphabet, (get_byte(b, i) % 32) + 1, 1);
    if i = 3 then s := s || '-'; end if;
  end loop;
  return s;
end $$;

-- ============ RPC implementations ============
create function private.create_invite(p_profile_id uuid) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare v_code text;
begin
  if not private.is_admin() then raise exception 'Only admins can create invite codes' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles where id = p_profile_id) then raise exception 'Profile not found'; end if;
  if exists (select 1 from public.profiles where id = p_profile_id and user_id is not null) then
    raise exception 'This profile is already linked to an account';
  end if;
  delete from public.invite_codes where profile_id = p_profile_id and used_at is null; -- one live code per profile
  loop
    v_code := private.new_invite_code();
    begin
      insert into public.invite_codes (code, profile_id, created_by) values (v_code, p_profile_id, auth.uid());
      exit;
    exception when unique_violation then -- astronomically unlikely; try again
    end;
  end loop;
  return v_code;
end $$;

create function private.redeem_invite(p_code text) returns json
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_code public.invite_codes%rowtype;
  v_profile public.profiles%rowtype;
  v_norm text;
begin
  if v_uid is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if exists (select 1 from public.profiles where user_id = v_uid) then
    raise exception 'This account is already linked to a profile';
  end if;
  -- accept "abcd efgh", "ABCDEFGH" or "ABCD-EFGH"
  v_norm := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if length(v_norm) = 8 then v_norm := left(v_norm, 4) || '-' || right(v_norm, 4); end if;
  select * into v_code from public.invite_codes where code = v_norm for update;
  if not found or v_code.used_at is not null or v_code.expires_at < now() then
    raise exception 'That code is not valid (it may be mistyped, used already, or expired)';
  end if;
  update public.profiles set user_id = v_uid where id = v_code.profile_id and user_id is null
  returning * into v_profile;
  if not found then raise exception 'That profile is already linked to another account'; end if;
  update public.invite_codes
     set used_at = now(), used_by = v_uid,
         used_email = (select email from auth.users where id = v_uid)
   where code = v_code.code;
  return json_build_object('id', v_profile.id, 'display_name', v_profile.display_name, 'role', v_profile.role);
end $$;

create function private.set_item_done(p_item_id uuid, p_done boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_me uuid := private.my_profile_id();
begin
  if v_me is null then raise exception 'No profile' using errcode = '42501'; end if;
  if not (private.is_admin() or exists (select 1 from public.items where id = p_item_id and assignee_id = v_me)) then
    raise exception 'You can only check off items assigned to you' using errcode = '42501';
  end if;
  update public.items set done = p_done where id = p_item_id;
  if not found then raise exception 'Item not found'; end if;
end $$;

-- ============ triggers ============
-- Stamp done_at / done_by whenever done flips (works for the RPC and direct admin updates).
create function private.items_stamp_done() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.done is distinct from old.done then
    if new.done then new.done_at := now(); new.done_by := private.my_profile_id();
    else new.done_at := null; new.done_by := null; end if;
  end if;
  return new;
end $$;
create trigger items_stamp_done before update of done on public.items
  for each row execute function private.items_stamp_done();

create function private.item_label(p_item_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select format('"%s" — %s @ %s', i.text, c.name,
                coalesce(nullif(a.nicknames[1], ''), a.address))
  from public.items i
  join public.punchlists pl on pl.id = i.punchlist_id
  join public.companies c on c.id = pl.company_id
  join public.addresses a on a.id = pl.address_id
  where i.id = p_item_id
$$;

-- Completed: notify everyone cc'd, plus admins when someone else finished it.
create function private.items_notify_completed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_label text; v_by text;
begin
  v_label := private.item_label(new.id);
  select display_name into v_by from public.profiles where id = new.done_by;
  insert into public.notifications (profile_id, item_id, kind, message)
  select r.pid, new.id, 'completed', format('Done: %s%s', v_label, coalesce(' (by ' || v_by || ')', ''))
  from (
    select c.profile_id as pid from public.item_ccs c where c.item_id = new.id
    union
    select p.id from public.profiles p
    where p.role = 'admin' and p.user_id is not null
      and coalesce((select d.role from public.profiles d where d.id = new.done_by), 'vendor') <> 'admin'
  ) r
  where r.pid is distinct from new.done_by;
  return null;
end $$;
create trigger items_notify_completed after update of done on public.items
  for each row when (new.done and not old.done) execute function private.items_notify_completed();

-- Assigned: tell the vendor they have a new item.
create function private.items_notify_assigned() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.assignee_id is not null and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id)
     and new.assignee_id is distinct from private.my_profile_id() then
    insert into public.notifications (profile_id, item_id, kind, message)
    values (new.assignee_id, new.id, 'assigned', 'New item for you: ' || private.item_label(new.id));
  end if;
  return null;
end $$;
create trigger items_notify_assigned after insert or update of assignee_id on public.items
  for each row execute function private.items_notify_assigned();

-- cc'd: tell the vendor they will hear when it's done.
create function private.item_ccs_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_assignee text; v_done boolean;
begin
  select p.display_name, i.done into v_assignee, v_done
  from public.items i left join public.profiles p on p.id = i.assignee_id where i.id = new.item_id;
  insert into public.notifications (profile_id, item_id, kind, message)
  values (new.profile_id, new.item_id, 'cc',
          format('You were cc''d on %s%s. %s', private.item_label(new.item_id),
                 coalesce(' (assigned to ' || v_assignee || ')', ''),
                 case when v_done then 'It is already done.' else 'You''ll be notified when it''s done.' end));
  return null;
end $$;
create trigger item_ccs_notify after insert on public.item_ccs
  for each row execute function private.item_ccs_notify();

-- ============ public RPC wrappers (security invoker) ============
create function public.create_invite(p_profile_id uuid) returns text
language sql volatile security invoker set search_path = '' as $$ select private.create_invite(p_profile_id) $$;
create function public.redeem_invite(p_code text) returns json
language sql volatile security invoker set search_path = '' as $$ select private.redeem_invite(p_code) $$;
create function public.set_item_done(p_item_id uuid, p_done boolean) returns void
language sql volatile security invoker set search_path = '' as $$ select private.set_item_done(p_item_id, p_done) $$;

-- ============ function privileges ============
revoke execute on all functions in schema private from public, anon;
grant execute on function private.my_profile_id(), private.is_admin(), private.my_cc_item_ids(),
  private.my_assigned_item_ids(), private.my_punchlist_ids(), private.my_company_ids(), private.my_address_ids(),
  private.my_visible_profile_ids(), private.create_invite(uuid), private.redeem_invite(text),
  private.set_item_done(uuid, boolean) to authenticated;
revoke execute on function public.create_invite(uuid), public.redeem_invite(text), public.set_item_done(uuid, boolean) from public, anon;
grant execute on function public.create_invite(uuid), public.redeem_invite(text), public.set_item_done(uuid, boolean) to authenticated;

-- ============ row level security ============
alter table public.profiles      enable row level security;
alter table public.invite_codes  enable row level security;
alter table public.companies     enable row level security;
alter table public.addresses     enable row level security;
alter table public.punchlists    enable row level security;
alter table public.items         enable row level security;
alter table public.item_ccs      enable row level security;
alter table public.notifications enable row level security;

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using ((select private.is_admin()) or id in (select private.my_visible_profile_ids()));
create policy profiles_insert on public.profiles for insert to authenticated with check ((select private.is_admin()));
create policy profiles_update on public.profiles for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy profiles_delete on public.profiles for delete to authenticated
  using ((select private.is_admin()) and user_id is distinct from (select auth.uid())); -- can't delete yourself

-- invite codes: admins read/delete; create + redeem go through RPCs
create policy invite_codes_select on public.invite_codes for select to authenticated using ((select private.is_admin()));
create policy invite_codes_delete on public.invite_codes for delete to authenticated using ((select private.is_admin()));

-- companies / addresses / punchlists: admins manage, vendors read the ones tied to their items
create policy companies_select on public.companies for select to authenticated
  using ((select private.is_admin()) or id in (select private.my_company_ids()));
create policy companies_insert on public.companies for insert to authenticated with check ((select private.is_admin()));
create policy companies_update on public.companies for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy companies_delete on public.companies for delete to authenticated using ((select private.is_admin()));

create policy addresses_select on public.addresses for select to authenticated
  using ((select private.is_admin()) or id in (select private.my_address_ids()));
create policy addresses_insert on public.addresses for insert to authenticated with check ((select private.is_admin()));
create policy addresses_update on public.addresses for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy addresses_delete on public.addresses for delete to authenticated using ((select private.is_admin()));

create policy punchlists_select on public.punchlists for select to authenticated
  using ((select private.is_admin()) or id in (select private.my_punchlist_ids()));
create policy punchlists_insert on public.punchlists for insert to authenticated with check ((select private.is_admin()));
create policy punchlists_update on public.punchlists for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy punchlists_delete on public.punchlists for delete to authenticated using ((select private.is_admin()));

-- items: vendors see assigned + cc'd; only admins write directly (vendors check off via set_item_done)
create policy items_select on public.items for select to authenticated
  using ((select private.is_admin())
         or assignee_id = (select private.my_profile_id())
         or id in (select private.my_cc_item_ids()));
create policy items_insert on public.items for insert to authenticated with check ((select private.is_admin()));
create policy items_update on public.items for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy items_delete on public.items for delete to authenticated using ((select private.is_admin()));

-- item_ccs: vendors see their own cc rows and who is cc'd on their assigned items
create policy item_ccs_select on public.item_ccs for select to authenticated
  using ((select private.is_admin())
         or profile_id = (select private.my_profile_id())
         or item_id in (select private.my_assigned_item_ids()));
create policy item_ccs_insert on public.item_ccs for insert to authenticated with check ((select private.is_admin()));
create policy item_ccs_delete on public.item_ccs for delete to authenticated using ((select private.is_admin()));

-- notifications: your own only
create policy notifications_select on public.notifications for select to authenticated
  using (profile_id = (select private.my_profile_id()));
create policy notifications_update on public.notifications for update to authenticated
  using (profile_id = (select private.my_profile_id())) with check (profile_id = (select private.my_profile_id()));
create policy notifications_delete on public.notifications for delete to authenticated
  using (profile_id = (select private.my_profile_id()));

-- ============ realtime ============
alter publication supabase_realtime add table
  public.notifications, public.items, public.item_ccs, public.punchlists,
  public.companies, public.addresses, public.profiles;
