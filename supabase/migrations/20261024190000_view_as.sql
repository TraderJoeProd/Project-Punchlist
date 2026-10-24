-- Punchlist v4: admin-only "View as" (preview the app exactly as a vendor employee sees it, no login).
-- * The vendor visibility rules are parameterised by profile (private.*_for(profile)); the RLS helpers
--   (private.my_*) now call those same functions with the caller's own profile, so RLS and View-as can't drift.
-- * public.view_as(profile)               -> json snapshot of what that employee can read (admins only).
-- * public.set_item_done_as(item, done, profile) -> check off as that employee; done_by = the employee (admins only).
-- * public.mark_notifications_read_as(profile, ids) -> mark that employee's alerts read (admins only).
-- * vendors.is_test / companies.is_test flag demo data.

alter table public.vendors   add column is_test boolean not null default false;
alter table public.companies add column is_test boolean not null default false;

-- ============ visibility rules, parameterised by profile ============
create function private.vendor_of(p_profile uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select vendor_id from public.profiles where id = p_profile
$$;

create function private.assigned_item_ids_for(p_profile uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select i.id from public.items i
  where i.vendor_id is not null and i.vendor_id = (select private.vendor_of(p_profile))
$$;

create function private.cc_item_ids_for(p_profile uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select c.item_id from public.item_ccs c where c.vendor_id = (select private.vendor_of(p_profile))
$$;

create function private.punchlist_ids_for(p_profile uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct i.punchlist_id from public.items i
  where i.id in (select private.assigned_item_ids_for(p_profile) union select private.cc_item_ids_for(p_profile))
$$;

create function private.company_ids_for(p_profile uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct company_id from public.punchlists where id in (select private.punchlist_ids_for(p_profile))
$$;

create function private.address_ids_for(p_profile uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct address_id from public.punchlists where id in (select private.punchlist_ids_for(p_profile))
$$;

create function private.visible_profile_ids_for(p_profile uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select p_profile where p_profile is not null
  union
  select p.id from public.profiles p where p.vendor_id = (select private.vendor_of(p_profile))
  union
  select x.pid from public.items i
    cross join lateral (values (i.assignee_id), (i.done_by)) x(pid)
  where x.pid is not null
    and i.id in (select private.assigned_item_ids_for(p_profile) union select private.cc_item_ids_for(p_profile))
$$;

create function private.visible_vendor_ids_for(p_profile uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select v from (select private.vendor_of(p_profile) as v) s where v is not null
  union
  select i.vendor_id from public.items i where i.id in (select private.cc_item_ids_for(p_profile)) and i.vendor_id is not null
  union
  select c.vendor_id from public.item_ccs c where c.item_id in (select private.assigned_item_ids_for(p_profile))
$$;

-- ============ RLS helpers = the same rules for the caller ============
create or replace function private.my_assigned_item_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select private.assigned_item_ids_for((select private.my_profile_id()))
$$;
create or replace function private.my_cc_item_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select private.cc_item_ids_for((select private.my_profile_id()))
$$;
create or replace function private.my_punchlist_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select private.punchlist_ids_for((select private.my_profile_id()))
$$;
create or replace function private.my_company_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select private.company_ids_for((select private.my_profile_id()))
$$;
create or replace function private.my_address_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select private.address_ids_for((select private.my_profile_id()))
$$;
create or replace function private.my_visible_profile_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select private.visible_profile_ids_for((select private.my_profile_id()))
$$;
create or replace function private.my_visible_vendor_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select private.visible_vendor_ids_for((select private.my_profile_id()))
$$;

-- ============ who is acting ============
-- Normally the caller's own profile. Inside set_item_done_as (admins only) it is the previewed employee.
create function private.acting_profile_id() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_as uuid;
begin
  begin v_as := nullif(current_setting('punchlist.act_as', true), '')::uuid;
  exception when others then v_as := null; end;
  if v_as is not null and private.is_admin()
     and exists (select 1 from public.profiles where id = v_as and role = 'vendor') then
    return v_as;
  end if;
  return private.my_profile_id();
end $$;

create or replace function private.items_stamp_done() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.done is distinct from old.done then
    if new.done then new.done_at := now(); new.done_by := private.acting_profile_id();
    else new.done_at := null; new.done_by := null; end if;
  end if;
  return new;
end $$;

-- Target must be a vendor employee; caller must be an admin.
create function private.assert_view_as(p_profile uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'Only admins can use View as' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles where id = p_profile and role = 'vendor') then
    raise exception 'View as works only for vendor employees' using errcode = '22023';
  end if;
end $$;

-- ============ View-as RPCs ============
-- Mirrors the non-admin branch of every select policy, for p_profile.
create function private.view_as(p_profile uuid) returns json
language plpgsql stable security definer set search_path = '' as $$
declare v_items uuid[];
begin
  perform private.assert_view_as(p_profile);
  v_items := array(select private.assigned_item_ids_for(p_profile) union select private.cc_item_ids_for(p_profile));
  return json_build_object(
    'me', (select row_to_json(x) from (select id, user_id, display_name, role, vendor_id, vendor_company
             from public.profiles where id = p_profile) x),
    'companies', coalesce((select json_agg(x order by x.name, x.id) from (select id, name, is_test from public.companies
             where id in (select private.company_ids_for(p_profile))) x), '[]'),
    'addresses', coalesce((select json_agg(x order by x.address, x.id) from (select id, address, nicknames from public.addresses
             where id in (select private.address_ids_for(p_profile))) x), '[]'),
    'punchlists', coalesce((select json_agg(x order by x.id) from (select id, company_id, address_id, created_at from public.punchlists
             where id in (select private.punchlist_ids_for(p_profile))) x), '[]'),
    'items', coalesce((select json_agg(x order by x.created_at, x.id) from (select id, punchlist_id, text, done, done_at, done_by, vendor_id,
             assignee_id, source, created_at from public.items where id = any (v_items)) x), '[]'),
    'item_ccs', coalesce((select json_agg(x order by x.item_id, x.vendor_id) from (select item_id, vendor_id from public.item_ccs
             where vendor_id = (select private.vendor_of(p_profile))
                or item_id in (select private.assigned_item_ids_for(p_profile))) x), '[]'),
    'vendors', coalesce((select json_agg(x order by x.name, x.id) from (select id, name, created_at, is_test from public.vendors
             where id in (select private.visible_vendor_ids_for(p_profile))) x), '[]'),
    'profiles', coalesce((select json_agg(x order by x.display_name, x.id) from (select id, user_id, display_name, role, vendor_id,
             vendor_company, created_at from public.profiles where id in (select private.visible_profile_ids_for(p_profile))) x), '[]'),
    'notifications', coalesce((select json_agg(x order by x.created_at desc, x.id desc) from (select id, item_id, kind, message, created_at, read_at
             from public.notifications where profile_id = p_profile order by created_at desc, id desc limit 100) x), '[]')
  );
end $$;

create function private.set_item_done_as(p_item_id uuid, p_done boolean, p_profile uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.assert_view_as(p_profile);
  if not exists (select 1 from public.items where id = p_item_id and vendor_id is not null
                 and vendor_id = (select private.vendor_of(p_profile))) then
    raise exception 'You can only check off your team''s items' using errcode = '42501';
  end if;
  perform set_config('punchlist.act_as', p_profile::text, true);
  update public.items set done = p_done where id = p_item_id;
  perform set_config('punchlist.act_as', '', true);
end $$;

create function private.mark_notifications_read_as(p_profile uuid, p_ids bigint[]) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.assert_view_as(p_profile);
  update public.notifications set read_at = now()
   where profile_id = p_profile and id = any (p_ids) and read_at is null;
end $$;

create function public.view_as(p_profile_id uuid) returns json
language sql stable security invoker set search_path = '' as $$ select private.view_as(p_profile_id) $$;
create function public.set_item_done_as(p_item_id uuid, p_done boolean, p_profile_id uuid) returns void
language sql volatile security invoker set search_path = '' as $$ select private.set_item_done_as(p_item_id, p_done, p_profile_id) $$;
create function public.mark_notifications_read_as(p_profile_id uuid, p_ids bigint[]) returns void
language sql volatile security invoker set search_path = '' as $$ select private.mark_notifications_read_as(p_profile_id, p_ids) $$;

-- ============ privileges ============
revoke execute on all functions in schema private from public, anon;
-- Only the three View-as entry points are callable by signed-in users (non-admins are rejected inside);
-- the *_for helpers run only inside SECURITY DEFINER code and are not granted to anyone.
grant execute on function private.view_as(uuid), private.set_item_done_as(uuid, boolean, uuid),
  private.mark_notifications_read_as(uuid, bigint[]) to authenticated;
revoke execute on function public.view_as(uuid), public.set_item_done_as(uuid, boolean, uuid),
  public.mark_notifications_read_as(uuid, bigint[]) from public, anon;
grant execute on function public.view_as(uuid), public.set_item_done_as(uuid, boolean, uuid),
  public.mark_notifications_read_as(uuid, bigint[]) to authenticated;
