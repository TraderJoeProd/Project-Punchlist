-- Punchlist v3: vendors are companies/teams with one or more employees (participants).
-- * public.vendors: the team (e.g. "D2"). Vendor-role profiles belong to exactly one vendor.
-- * items.vendor_id: the vendor an item is assigned to; items.assignee_id optionally narrows it to one
--   employee. Every employee of the vendor sees the vendor's items and can check them off.
-- * item_ccs now points at a vendor; every employee of a cc'd vendor is notified.
-- Existing vendor profiles are migrated: profiles that share a vendor_company become one vendor;
-- otherwise each vendor profile becomes its own vendor (named after vendor_company or the person).

-- ============ vendors ============
create table public.vendors (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) > 0),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
revoke all on public.vendors from anon;
alter table public.vendors enable row level security;

alter table public.profiles add column vendor_id uuid references public.vendors (id) on delete cascade;
create index profiles_vendor_id_idx on public.profiles (vendor_id);

-- migrate existing vendor profiles
create temporary table _vmap on commit drop as
  select p.id as profile_id, coalesce(nullif(btrim(p.vendor_company), ''), p.display_name) as vname,
         coalesce(lower(nullif(btrim(p.vendor_company), '')), 'profile:' || p.id::text) as vkey
  from public.profiles p where p.role = 'vendor';
create temporary table _vnew on commit drop as
  select distinct on (vkey) vkey, vname, gen_random_uuid() as vendor_id from _vmap order by vkey, vname;
insert into public.vendors (id, name, created_by) select vendor_id, vname, null from _vnew;
update public.profiles p set vendor_id = n.vendor_id from _vmap m join _vnew n using (vkey) where p.id = m.profile_id;

alter table public.profiles add constraint profiles_vendor_role_chk
  check ((role = 'admin' and vendor_id is null) or (role = 'vendor' and vendor_id is not null));

-- ============ items: vendor assignment ============
alter table public.items add column vendor_id uuid references public.vendors (id) on delete set null;
create index items_vendor_id_idx on public.items (vendor_id);
update public.items i set vendor_id = p.vendor_id from public.profiles p where p.id = i.assignee_id;

-- ============ item_ccs: cc a vendor ============
alter table public.item_ccs add column vendor_id uuid references public.vendors (id) on delete cascade;
update public.item_ccs c set vendor_id = p.vendor_id from public.profiles p where p.id = c.profile_id;
delete from public.item_ccs where vendor_id is null;                -- admins were never cc-able in the UI
delete from public.item_ccs a using public.item_ccs b               -- two employees of one vendor -> one row
  where a.item_id = b.item_id and a.vendor_id = b.vendor_id and a.ctid > b.ctid;
alter table public.item_ccs drop constraint item_ccs_pkey;
drop policy item_ccs_select on public.item_ccs;                     -- references profile_id; recreated below
alter table public.item_ccs drop column profile_id;                 -- also drops item_ccs_profile_id_idx
alter table public.item_ccs alter column vendor_id set not null;
alter table public.item_ccs add primary key (item_id, vendor_id);
create index item_ccs_vendor_id_idx on public.item_ccs (vendor_id);

-- ============ helpers ============
create function private.my_vendor_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select vendor_id from public.profiles where user_id = (select auth.uid())
$$;

-- Items assigned to the caller's vendor (any employee sees them all).
create or replace function private.my_assigned_item_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select i.id from public.items i
  where i.vendor_id is not null and i.vendor_id = (select private.my_vendor_id())
$$;

-- Items the caller's vendor is cc'd on.
create or replace function private.my_cc_item_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select c.item_id from public.item_ccs c
  where c.vendor_id = (select private.my_vendor_id())
$$;

-- Profiles a vendor employee can see: their co-workers, plus the assignee / completer of any item they can see.
create or replace function private.my_visible_profile_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select private.my_profile_id()
  union
  select p.id from public.profiles p where p.vendor_id = (select private.my_vendor_id())
  union
  select x.pid from public.items i
    cross join lateral (values (i.assignee_id), (i.done_by)) x(pid)
  where x.pid is not null
    and i.id in (select private.my_assigned_item_ids() union select private.my_cc_item_ids())
$$;

-- Vendors an employee can see: their own, vendors doing items they're cc'd on, vendors cc'd on their items.
create function private.my_visible_vendor_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select private.my_vendor_id()
  union
  select i.vendor_id from public.items i where i.id in (select private.my_cc_item_ids()) and i.vendor_id is not null
  union
  select c.vendor_id from public.item_ccs c where c.item_id in (select private.my_assigned_item_ids())
$$;

-- ============ check-off: any employee of the item's vendor ============
create or replace function private.set_item_done(p_item_id uuid, p_done boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_me uuid := private.my_profile_id(); v_vendor uuid := private.my_vendor_id();
begin
  if v_me is null then raise exception 'No profile' using errcode = '42501'; end if;
  if not (private.is_admin()
          or (v_vendor is not null and exists (select 1 from public.items where id = p_item_id and vendor_id = v_vendor))) then
    raise exception 'You can only check off your team''s items' using errcode = '42501';
  end if;
  update public.items set done = p_done where id = p_item_id;
  if not found then raise exception 'Item not found'; end if;
end $$;

-- ============ keep vendor_id / assignee_id consistent ============
-- An employee assignee pins vendor_id to their vendor; an admin assignee has no vendor.
-- Changing only the vendor drops an employee who isn't on the new vendor.
create function private.items_sync_vendor() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_vendor uuid;
begin
  if new.assignee_id is null then return new; end if;
  select vendor_id into v_vendor from public.profiles where id = new.assignee_id;
  if tg_op = 'UPDATE' and new.assignee_id is not distinct from old.assignee_id
     and new.vendor_id is distinct from old.vendor_id and v_vendor is distinct from new.vendor_id then
    new.assignee_id := null;
  else
    new.vendor_id := v_vendor;
  end if;
  return new;
end $$;
create trigger items_sync_vendor before insert or update of assignee_id, vendor_id on public.items
  for each row execute function private.items_sync_vendor();

-- When an employee moves to another vendor, unassign them from their old vendor's open items.
create function private.profiles_vendor_moved() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.items set assignee_id = null
   where assignee_id = new.id and vendor_id is distinct from new.vendor_id;
  return null;
end $$;
create trigger profiles_vendor_moved after update of vendor_id on public.profiles
  for each row when (new.vendor_id is distinct from old.vendor_id) execute function private.profiles_vendor_moved();

-- ============ notifications ============
create or replace function private.item_label(p_item_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select format('"%s" — %s @ %s', i.text, c.name, coalesce(nullif(a.nicknames[1], ''), a.address))
  from public.items i
  join public.punchlists pl on pl.id = i.punchlist_id
  join public.companies c on c.id = pl.company_id
  join public.addresses a on a.id = pl.address_id
  where i.id = p_item_id
$$;

-- Who an item is with, e.g. "D2" or "D2 · Leo" or "Joseph".
create function private.item_owner(p_item_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select nullif(concat_ws(' · ', v.name, p.display_name), '')
  from public.items i
  left join public.vendors v on v.id = i.vendor_id
  left join public.profiles p on p.id = i.assignee_id
  where i.id = p_item_id
$$;

-- Completed: every employee of each cc'd vendor, plus linked admins when a non-admin finished it.
create or replace function private.items_notify_completed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_label text; v_by text;
begin
  v_label := private.item_label(new.id);
  select concat(p.display_name, coalesce(' (' || v.name || ')', '')) into v_by
    from public.profiles p left join public.vendors v on v.id = p.vendor_id where p.id = new.done_by;
  insert into public.notifications (profile_id, item_id, kind, message)
  select r.pid, new.id, 'completed', format('Done: %s%s', v_label, coalesce(' — by ' || v_by, ''))
  from (
    select p.id as pid from public.item_ccs c join public.profiles p on p.vendor_id = c.vendor_id where c.item_id = new.id
    union
    select p.id from public.profiles p
    where p.role = 'admin' and p.user_id is not null
      and coalesce((select d.role from public.profiles d where d.id = new.done_by), 'vendor') <> 'admin'
  ) r
  where r.pid is distinct from new.done_by;
  return null;
end $$;

-- Assigned: the named employee, or every employee of the vendor when no one is named.
create or replace function private.items_notify_assigned() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.assignee_id is not distinct from old.assignee_id
     and new.vendor_id is not distinct from old.vendor_id then
    return null;
  end if;
  insert into public.notifications (profile_id, item_id, kind, message)
  select p.id, new.id, 'assigned',
         'New item for ' || case when new.assignee_id is null then 'your team' else 'you' end || ': ' || private.item_label(new.id)
  from public.profiles p
  where (case when new.assignee_id is not null then p.id = new.assignee_id else p.vendor_id = new.vendor_id end)
    and p.id is distinct from private.my_profile_id();
  return null;
end $$;
drop trigger items_notify_assigned on public.items;
create trigger items_notify_assigned after insert or update of assignee_id, vendor_id on public.items
  for each row execute function private.items_notify_assigned();

-- cc'd: every employee of the cc'd vendor.
create or replace function private.item_ccs_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_owner text; v_done boolean; v_label text;
begin
  select i.done into v_done from public.items i where i.id = new.item_id;
  v_owner := private.item_owner(new.item_id);
  v_label := private.item_label(new.item_id);
  insert into public.notifications (profile_id, item_id, kind, message)
  select p.id, new.item_id, 'cc',
         format('Your team was cc''d on %s%s. %s', v_label, coalesce(' (assigned to ' || v_owner || ')', ''),
                case when v_done then 'It is already done.' else 'You''ll be notified when it''s done.' end)
  from public.profiles p where p.vendor_id = new.vendor_id;
  return null;
end $$;

-- ============ privileges ============
revoke execute on all functions in schema private from public, anon;
grant execute on function private.my_vendor_id(), private.my_visible_vendor_ids() to authenticated;

-- ============ policies ============
create policy vendors_select on public.vendors for select to authenticated
  using ((select private.is_admin()) or id in (select private.my_visible_vendor_ids()));
create policy vendors_insert on public.vendors for insert to authenticated with check ((select private.is_admin()));
create policy vendors_update on public.vendors for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy vendors_delete on public.vendors for delete to authenticated using ((select private.is_admin()));

drop policy items_select on public.items;
create policy items_select on public.items for select to authenticated
  using ((select private.is_admin())
         or (vendor_id is not null and vendor_id = (select private.my_vendor_id()))
         or id in (select private.my_cc_item_ids()));

create policy item_ccs_select on public.item_ccs for select to authenticated
  using ((select private.is_admin())
         or vendor_id = (select private.my_vendor_id())
         or item_id in (select private.my_assigned_item_ids()));

-- ============ realtime ============
alter publication supabase_realtime add table public.vendors;
