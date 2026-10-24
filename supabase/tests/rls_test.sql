-- RLS / RPC test. Runs entirely inside one transaction and ends by raising an exception that
-- carries the results, so every row it creates is rolled back. Expect "RESULTS: ... FAILS=0".
do $$
declare
  ua uuid := gen_random_uuid(); uv1 uuid := gen_random_uuid(); uv2 uuid := gen_random_uuid(); uv3 uuid := gen_random_uuid();
  pa uuid; v1 uuid; v2 uuid; co uuid; ad uuid; pl uuid; i1 uuid; i2 uuid; i3 uuid;
  code text; n int; t text; out text := ''; fails int := 0;
  procedure_ok boolean;
begin
  insert into auth.users (id, email, aud, role) values
    (ua, 'rls-admin@example.invalid', 'authenticated', 'authenticated'),
    (uv1, 'rls-v1@example.invalid', 'authenticated', 'authenticated'),
    (uv2, 'rls-v2@example.invalid', 'authenticated', 'authenticated'),
    (uv3, 'rls-nobody@example.invalid', 'authenticated', 'authenticated');
  insert into public.profiles (user_id, display_name, role) values (ua, 'Test Admin', 'admin') returning id into pa;

  -- ===== as ADMIN =====
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into public.profiles (display_name, role, vendor_company) values ('Mike Plumbing', 'vendor', 'Mike''s Plumbing') returning id into v1;
  insert into public.profiles (display_name, role, vendor_company) values ('Dan Drywall', 'vendor', 'Dan Drywall LLC') returning id into v2;
  insert into public.companies (name) values ('L&L Builders') returning id into co;
  insert into public.addresses (address, nicknames) values ('123 Ocean Blvd, Boca Raton, FL', '{Ocean}') returning id into ad;
  insert into public.punchlists (company_id, address_id) values (co, ad) returning id into pl;
  insert into public.items (punchlist_id, text, assignee_id) values (pl, 'Rough-in plumbing', v1) returning id into i1;
  insert into public.items (punchlist_id, text, assignee_id) values (pl, 'Hang drywall in bath', v2) returning id into i2;
  insert into public.items (punchlist_id, text) values (pl, 'Unassigned item') returning id into i3;
  insert into public.item_ccs (item_id, profile_id) values (i1, v2);
  code := public.create_invite(v1);
  out := out || format('admin: created code %s; ', code);
  select count(*) into n from public.items; if n <> 3 then fails := fails + 1; out := out || 'FAIL admin sees ' || n || ' items; '; else out := out || 'ok admin sees 3 items; '; end if;
  select count(*) into n from public.invite_codes; if n <> 1 then fails := fails + 1; out := out || 'FAIL admin invite rows; '; else out := out || 'ok admin sees codes; '; end if;
  execute 'reset role';
  update public.profiles set user_id = uv2 where id = v2; -- link V2 directly for the test

  -- ===== as VENDOR 1 (redeem) =====
  perform set_config('request.jwt.claims', json_build_object('sub', uv1, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.items; if n <> 0 then fails := fails + 1; out := out || 'FAIL unlinked v1 sees items; '; else out := out || 'ok unlinked user sees 0 items; '; end if;
  perform public.redeem_invite(lower(replace(code, '-', ' ')));
  out := out || 'ok v1 redeemed code (lowercase, space instead of dash); ';
  begin perform public.redeem_invite(code); fails := fails + 1; out := out || 'FAIL second redeem allowed; ';
  exception when others then out := out || 'ok second redeem blocked (' || sqlerrm || '); '; end;
  select count(*) into n from public.items; if n <> 1 then fails := fails + 1; out := out || 'FAIL v1 sees ' || n || ' items; '; else out := out || 'ok v1 sees only its 1 item; '; end if;
  select count(*) into n from public.companies; if n <> 1 then fails := fails + 1; out := out || 'FAIL v1 company; '; else out := out || 'ok v1 sees the job company; '; end if;
  select count(*) into n from public.addresses; if n <> 1 then fails := fails + 1; out := out || 'FAIL v1 address; '; else out := out || 'ok v1 sees the job address; '; end if;
  select count(*) into n from public.profiles; out := out || format('v1 sees %s profiles (self + cc''d on own item); ', n);
  if n <> 2 then fails := fails + 1; out := out || 'FAIL profile count; '; end if;
  select count(*) into n from public.invite_codes; if n <> 0 then fails := fails + 1; out := out || 'FAIL v1 sees codes; '; else out := out || 'ok v1 sees 0 codes; '; end if;
  begin insert into public.companies (name) values ('Hacker Co'); fails := fails + 1; out := out || 'FAIL v1 inserted company; ';
  exception when others then out := out || 'ok v1 cannot add company; '; end;
  begin insert into public.items (punchlist_id, text) values (pl, 'sneaky'); fails := fails + 1; out := out || 'FAIL v1 inserted item; ';
  exception when others then out := out || 'ok v1 cannot add item; '; end;
  update public.items set text = 'changed' where id = i1; get diagnostics n = row_count;
  if n <> 0 then fails := fails + 1; out := out || 'FAIL v1 edited text; '; else out := out || 'ok v1 cannot edit item text; '; end if;
  delete from public.items where id = i1; get diagnostics n = row_count;
  if n <> 0 then fails := fails + 1; out := out || 'FAIL v1 deleted; '; else out := out || 'ok v1 cannot delete; '; end if;
  update public.profiles set role = 'admin' where id = v1; get diagnostics n = row_count;
  if n <> 0 then fails := fails + 1; out := out || 'FAIL v1 self-promoted; '; else out := out || 'ok v1 cannot promote self; '; end if;
  begin perform public.create_invite(v2); fails := fails + 1; out := out || 'FAIL v1 created invite; ';
  exception when others then out := out || 'ok v1 cannot create codes; '; end;
  begin perform public.set_item_done(i2, true); fails := fails + 1; out := out || 'FAIL v1 checked other item; ';
  exception when others then out := out || 'ok v1 cannot check off others'' items; '; end;
  begin insert into public.item_ccs (item_id, profile_id) values (i2, v1); fails := fails + 1; out := out || 'FAIL v1 added cc; ';
  exception when others then out := out || 'ok v1 cannot add cc; '; end;
  perform public.set_item_done(i1, true);
  out := out || 'ok v1 checked off own item; ';
  execute 'reset role';
  select done_by::text into t from public.items where id = i1;
  if t is distinct from v1::text then fails := fails + 1; out := out || 'FAIL done_by not stamped; '; else out := out || 'ok done_at/done_by stamped; '; end if;

  -- ===== as VENDOR 2 (cc'd) =====
  perform set_config('request.jwt.claims', json_build_object('sub', uv2, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.items; if n <> 2 then fails := fails + 1; out := out || 'FAIL v2 sees ' || n || '; '; else out := out || 'ok v2 sees own item + cc''d item; '; end if;
  select count(*) into n from public.notifications where kind = 'completed' and item_id = i1;
  if n <> 1 then fails := fails + 1; out := out || 'FAIL v2 completed notif ' || n || '; '; else out := out || 'ok v2 got "completed" notification; '; end if;
  select message into t from public.notifications where kind = 'completed' and item_id = i1; out := out || 'msg=[' || coalesce(t, '') || ']; ';
  select count(*) into n from public.notifications where kind = 'cc'; if n <> 1 then fails := fails + 1; out := out || 'FAIL v2 cc notif; '; else out := out || 'ok v2 got cc notification; '; end if;
  begin perform public.set_item_done(i1, false); fails := fails + 1; out := out || 'FAIL v2 toggled cc item; ';
  exception when others then out := out || 'ok v2 cannot toggle cc''d item; '; end;
  update public.notifications set read_at = now(); get diagnostics n = row_count; out := out || format('v2 marked %s own notifs read; ', n);
  begin update public.notifications set message = 'x'; fails := fails + 1; out := out || 'FAIL v2 edited message; ';
  exception when others then out := out || 'ok notif message read-only; '; end;
  execute 'reset role';

  -- ===== admin sees completion notification; v1 sees only its own notifs =====
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.notifications where kind = 'completed'; if n <> 1 then fails := fails + 1; out := out || 'FAIL admin completed notif ' || n || '; '; else out := out || 'ok admin notified of vendor completion; '; end if;
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', uv1, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.notifications where profile_id <> v1; if n <> 0 then fails := fails + 1; out := out || 'FAIL v1 sees others notifs; '; else out := out || 'ok v1 sees only own notifications; '; end if;
  execute 'reset role';

  -- ===== user with no profile =====
  perform set_config('request.jwt.claims', json_build_object('sub', uv3, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select (select count(*) from public.items) + (select count(*) from public.companies) + (select count(*) from public.profiles) + (select count(*) from public.punchlists) into n;
  if n <> 0 then fails := fails + 1; out := out || 'FAIL no-profile user sees rows; '; else out := out || 'ok no-profile user sees nothing; '; end if;
  begin perform public.redeem_invite(code); fails := fails + 1; out := out || 'FAIL reused code; ';
  exception when others then out := out || 'ok used code rejected for another user; '; end;
  begin perform public.redeem_invite('ZZZZ-ZZZZ'); fails := fails + 1; out := out || 'FAIL bogus code; ';
  exception when others then out := out || 'ok bogus code rejected; '; end;
  execute 'reset role';

  -- ===== anon =====
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  execute 'set local role anon';
  begin select count(*) into n from public.items; fails := fails + 1; out := out || 'FAIL anon read items; ';
  exception when others then out := out || 'ok anon denied (' || sqlstate || '); '; end;
  begin perform public.redeem_invite('ABCD-EFGH'); fails := fails + 1; out := out || 'FAIL anon rpc; ';
  exception when others then out := out || 'ok anon cannot call RPC; '; end;
  execute 'reset role';

  raise exception 'RESULTS: % FAILS=%', out, fails;
end $$;
