-- RLS / RPC test for Punchlist v3 (vendor teams). Runs inside one transaction and finishes by raising an
-- exception that carries the results, so every row it creates is rolled back. Expect "FAILS=0".
do $$
declare
  ua uuid := gen_random_uuid(); ul uuid := gen_random_uuid(); us uuid := gen_random_uuid();
  um uuid := gen_random_uuid(); un uuid := gen_random_uuid();
  pa uuid; d2 uuid; ro uuid; leo uuid; sam uuid; mike uuid; co uuid; ad uuid; pl uuid;
  i1 uuid; i2 uuid; i3 uuid; i4 uuid; i5 uuid;
  code text; n int; t text; out text := ''; fails int := 0;
begin
  insert into auth.users (id, email, aud, role) values
    (ua, 'rls-admin@example.invalid', 'authenticated', 'authenticated'),
    (ul, 'rls-leo@example.invalid', 'authenticated', 'authenticated'),
    (us, 'rls-sam@example.invalid', 'authenticated', 'authenticated'),
    (um, 'rls-mike@example.invalid', 'authenticated', 'authenticated'),
    (un, 'rls-nobody@example.invalid', 'authenticated', 'authenticated');
  insert into public.profiles (user_id, display_name, role) values (ua, 'Test Admin', 'admin') returning id into pa;

  -- ===== ADMIN sets up D2 (Leo, Sam) and Rossi Plumbing (Mike) =====
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into public.vendors (name) values ('D2') returning id into d2;
  insert into public.vendors (name) values ('Rossi Plumbing') returning id into ro;
  insert into public.profiles (display_name, role, vendor_id) values ('Leo', 'vendor', d2) returning id into leo;
  insert into public.profiles (display_name, role, vendor_id) values ('Sam', 'vendor', d2) returning id into sam;
  insert into public.profiles (display_name, role, vendor_id) values ('Mike', 'vendor', ro) returning id into mike;
  begin insert into public.profiles (display_name, role) values ('No team', 'vendor'); fails := fails + 1; out := out || 'FAIL vendor without team allowed; ';
  exception when check_violation then out := out || 'ok vendor profile must belong to a vendor; '; end;
  insert into public.companies (name) values ('L&L Builders') returning id into co;
  insert into public.addresses (address, nicknames) values ('123 Ocean Blvd, Boca Raton, FL', '{Ocean}') returning id into ad;
  insert into public.punchlists (company_id, address_id) values (co, ad) returning id into pl;
  insert into public.items (punchlist_id, text, vendor_id) values (pl, 'Frame closet', d2) returning id into i1;
  insert into public.items (punchlist_id, text, assignee_id) values (pl, 'Trim master door', leo) returning id into i2;
  insert into public.items (punchlist_id, text, vendor_id) values (pl, 'Rough-in plumbing', ro) returning id into i3;
  insert into public.items (punchlist_id, text) values (pl, 'Unassigned item') returning id into i4;
  insert into public.items (punchlist_id, text, vendor_id, assignee_id) values (pl, 'Mismatch test', ro, leo) returning id into i5;
  insert into public.item_ccs (item_id, vendor_id) values (i3, d2);
  select vendor_id::text into t from public.items where id = i2;
  if t is distinct from d2::text then fails := fails + 1; out := out || 'FAIL employee assignee did not set vendor; '; else out := out || 'ok assigning Leo sets vendor D2; '; end if;
  select vendor_id::text into t from public.items where id = i5;
  if t is distinct from d2::text then fails := fails + 1; out := out || 'FAIL mismatched vendor kept; '; else out := out || 'ok employee wins over mismatched vendor; '; end if;
  delete from public.items where id = i5;
  code := public.create_invite(sam);
  execute 'reset role';
  update public.profiles set user_id = ul where id = leo;
  update public.profiles set user_id = um where id = mike;

  -- ===== SAM (D2) redeems code, sees all D2 items, checks off Leo's item =====
  perform set_config('request.jwt.claims', json_build_object('sub', us, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  perform public.redeem_invite(lower(code));
  out := out || 'ok Sam linked by code; ';
  select count(*) into n from public.items where vendor_id = d2;
  if n <> 2 then fails := fails + 1; out := out || 'FAIL Sam sees ' || n || ' D2 items; '; else out := out || 'ok Sam sees both D2 items (incl. one narrowed to Leo); '; end if;
  select count(*) into n from public.items; if n <> 3 then fails := fails + 1; out := out || 'FAIL Sam sees ' || n || ' items total; '; else out := out || 'ok Sam sees 2 D2 + 1 cc item; '; end if;
  select count(*) into n from public.items where id = i4; if n <> 0 then fails := fails + 1; out := out || 'FAIL Sam sees unassigned; '; end if;
  select count(*) into n from public.notifications where kind = 'assigned' and item_id = i1;
  if n <> 1 then fails := fails + 1; out := out || 'FAIL Sam assigned notif ' || n || '; '; else out := out || 'ok team assignment notified Sam; '; end if;
  select count(*) into n from public.notifications where kind = 'assigned' and item_id = i2;
  if n <> 0 then fails := fails + 1; out := out || 'FAIL Sam notified for Leo-only item; '; else out := out || 'ok Leo-only assignment not sent to Sam; '; end if;
  select count(*) into n from public.notifications where kind = 'cc'; if n <> 1 then fails := fails + 1; out := out || 'FAIL Sam cc notif; '; else out := out || 'ok Sam got cc notification; '; end if;
  perform public.set_item_done(i2, true);
  out := out || 'ok Sam checked off D2 item narrowed to Leo; ';
  begin perform public.set_item_done(i3, true); fails := fails + 1; out := out || 'FAIL Sam toggled cc item; ';
  exception when others then out := out || 'ok cc item read-only for Sam; '; end;
  update public.vendors set name = 'Hacked' where id = d2; get diagnostics n = row_count;
  if n <> 0 then fails := fails + 1; out := out || 'FAIL Sam renamed vendor; '; else out := out || 'ok Sam cannot edit vendor; '; end if;
  begin insert into public.vendors (name) values ('Sneaky'); fails := fails + 1; out := out || 'FAIL Sam inserted vendor; ';
  exception when others then out := out || 'ok Sam cannot add vendor; '; end;
  update public.profiles set vendor_id = ro where id = sam; get diagnostics n = row_count;
  if n <> 0 then fails := fails + 1; out := out || 'FAIL Sam switched team; '; else out := out || 'ok Sam cannot switch team; '; end if;
  update public.items set text = 'x' where id = i1; get diagnostics n = row_count;
  if n <> 0 then fails := fails + 1; out := out || 'FAIL Sam edited item; '; else out := out || 'ok Sam cannot edit item text; '; end if;
  select count(*) into n from public.invite_codes; if n <> 0 then fails := fails + 1; out := out || 'FAIL Sam sees codes; '; end if;
  execute 'reset role';
  select done_by::text into t from public.items where id = i2;
  if t is distinct from sam::text then fails := fails + 1; out := out || 'FAIL done_by; '; else out := out || 'ok done_by = Sam; '; end if;

  -- ===== LEO (D2) sees it done by Sam =====
  perform set_config('request.jwt.claims', json_build_object('sub', ul, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.items where vendor_id = d2; if n <> 2 then fails := fails + 1; out := out || 'FAIL Leo D2 items; '; else out := out || 'ok Leo sees both D2 items; '; end if;
  select count(*) into n from public.items where id = i2 and done and done_by = sam;
  if n <> 1 then fails := fails + 1; out := out || 'FAIL Leo does not see done by Sam; '; else out := out || 'ok Leo sees item done by Sam; '; end if;
  select count(*) into n from public.profiles where id in (sam, leo); if n <> 2 then fails := fails + 1; out := out || 'FAIL Leo co-worker visibility; '; else out := out || 'ok Leo sees co-worker Sam; '; end if;
  select count(*) into n from public.vendors; if n <> 2 then fails := fails + 1; out := out || 'FAIL Leo sees ' || n || ' vendors; '; else out := out || 'ok Leo sees D2 + vendor of cc item; '; end if;
  perform public.set_item_done(i1, true); perform public.set_item_done(i1, false);
  out := out || 'ok Leo can check/uncheck a D2 item; ';
  execute 'reset role';

  -- ===== MIKE (Rossi) sees nothing of D2, completes the item D2 is cc'd on =====
  perform set_config('request.jwt.claims', json_build_object('sub', um, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.items; if n <> 1 then fails := fails + 1; out := out || 'FAIL Mike sees ' || n || ' items; '; else out := out || 'ok Mike sees only his 1 item; '; end if;
  select count(*) into n from public.items where vendor_id = d2; if n <> 0 then fails := fails + 1; out := out || 'FAIL Mike sees D2 items; '; else out := out || 'ok Mike sees 0 D2 items; '; end if;
  select count(*) into n from public.profiles where id in (leo, sam); if n <> 0 then fails := fails + 1; out := out || 'FAIL Mike sees D2 people; '; else out := out || 'ok Mike sees no D2 employees; '; end if;
  select count(*) into n from public.item_ccs where item_id = i3; if n <> 1 then fails := fails + 1; out := out || 'FAIL Mike cc row; '; else out := out || 'ok Mike sees D2 is cc''d on his item; '; end if;
  begin perform public.set_item_done(i1, true); fails := fails + 1; out := out || 'FAIL Mike toggled D2 item; ';
  exception when others then out := out || 'ok Mike cannot check off D2 items; '; end;
  perform public.set_item_done(i3, true);
  execute 'reset role';

  -- cc fan-out: both D2 employees notified, admin notified
  select count(*) into n from public.notifications where kind = 'completed' and item_id = i3 and profile_id in (leo, sam);
  if n <> 2 then fails := fails + 1; out := out || 'FAIL cc fan-out ' || n || '; '; else out := out || 'ok both D2 employees notified when Mike finished; '; end if;
  select count(*) into n from public.notifications where kind = 'completed' and item_id = i3 and profile_id = pa;
  if n <> 1 then fails := fails + 1; out := out || 'FAIL admin notif; '; else out := out || 'ok admin notified; '; end if;
  select count(*) into n from public.notifications where kind = 'completed' and item_id = i2 and profile_id = pa;
  if n <> 1 then fails := fails + 1; out := out || 'FAIL admin notif for Sam; '; else out := out || 'ok admin notified when Sam finished; '; end if;
  select message into t from public.notifications where kind = 'completed' and item_id = i3 and profile_id = leo;
  out := out || 'msg=[' || coalesce(t, '') || ']; ';
  if t not like '%by Mike (Rossi Plumbing)%' then fails := fails + 1; out := out || 'FAIL completer not named; '; end if;
  select count(*) into n from public.notifications where kind = 'cc' and profile_id in (leo, sam);
  if n <> 2 then fails := fails + 1; out := out || 'FAIL cc notif fan-out; '; else out := out || 'ok cc notification went to both D2 employees; '; end if;

  -- ===== nobody / anon =====
  perform set_config('request.jwt.claims', json_build_object('sub', un, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select (select count(*) from public.items) + (select count(*) from public.vendors) + (select count(*) from public.profiles) into n;
  if n <> 0 then fails := fails + 1; out := out || 'FAIL no-profile user sees rows; '; else out := out || 'ok no-profile user sees nothing; '; end if;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  execute 'set local role anon';
  begin select count(*) into n from public.vendors; fails := fails + 1; out := out || 'FAIL anon read vendors; ';
  exception when insufficient_privilege then out := out || 'ok anon denied; '; end;
  execute 'reset role';

  -- profile moved to another team loses narrowed assignment
  update public.items set done = false, assignee_id = leo where id = i1;
  update public.profiles set vendor_id = ro where id = leo;
  select count(*) into n from public.items where id = i1 and assignee_id is null and vendor_id = d2;
  if n <> 1 then fails := fails + 1; out := out || 'FAIL move team; '; else out := out || 'ok moving Leo to another team unassigns him from D2 items; '; end if;

  raise exception 'RESULTS: % FAILS=%', out, fails;
end $$;
