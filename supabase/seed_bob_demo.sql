-- Demo data for trying the vendor experience via "View as" (flagged is_test). Safe to re-run: skips if it exists.
-- Remove later with: delete from public.companies where is_test; delete from public.addresses where address = '123 Test St';
--                    delete from public.vendors where is_test;   (employees + items' vendor links go with them)
do $$
declare v uuid; b uuid; c uuid; a uuid; pl uuid; i4 uuid;
begin
  if exists (select 1 from public.vendors where name = 'Bob Building Co') then raise notice 'already seeded'; return; end if;
  insert into public.vendors (name, is_test, created_by) values ('Bob Building Co', true, null) returning id into v;
  insert into public.profiles (display_name, role, vendor_id) values ('Bob', 'vendor', v) returning id into b;
  select id into c from public.companies where name = 'Test Co';
  if c is null then insert into public.companies (name, is_test, created_by) values ('Test Co', true, null) returning id into c; end if;
  select id into a from public.addresses where address = '123 Test St';
  if a is null then insert into public.addresses (address, nicknames, created_by) values ('123 Test St', '{Test job}', null) returning id into a; end if;
  insert into public.punchlists (company_id, address_id, created_by) values (c, a, null)
    on conflict (company_id, address_id) do update set company_id = excluded.company_id returning id into pl;
  insert into public.items (punchlist_id, text, vendor_id, created_by) values (pl, 'Patch drywall by front door', v, null);
  insert into public.items (punchlist_id, text, assignee_id, created_by) values (pl, 'Touch up paint in hallway', b, null);
  insert into public.items (punchlist_id, text, vendor_id, created_by) values (pl, 'Re-hang closet doors in bedroom 2', v, null);
  insert into public.items (punchlist_id, text, created_by) values (pl, 'Regrout guest bath shower', null) returning id into i4;
  insert into public.item_ccs (item_id, vendor_id) values (i4, v);
end $$;
select v.id vendor_id, v.name, v.is_test, p.id bob_profile_id, p.display_name,
  (select count(*) from public.items where vendor_id = v.id) team_items,
  (select count(*) from public.item_ccs where vendor_id = v.id) cc_items,
  (select count(*) from public.notifications where profile_id = p.id) bob_alerts
from public.vendors v join public.profiles p on p.vendor_id = v.id where v.name = 'Bob Building Co';
