-- Temporary data for tests/e2e-v3.js. Remove with e2e-v3-cleanup.sql. Logins use example.invalid (no email is sent).
do $$
declare u record;
begin
  for u in select * from (values
    ('11111111-0000-4000-8000-000000000001'::uuid, 'pl-test-admin@example.invalid'),
    ('11111111-0000-4000-8000-000000000002'::uuid, 'pl-test-leo@example.invalid'),
    ('11111111-0000-4000-8000-000000000003'::uuid, 'pl-test-sam@example.invalid'),
    ('11111111-0000-4000-8000-000000000004'::uuid, 'pl-test-mike@example.invalid'),
    ('11111111-0000-4000-8000-000000000005'::uuid, 'pl-test-nina@example.invalid')) v(id, email)
  loop
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current,
      reauthentication_token, phone_change, phone_change_token)
    values ('00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email,
      extensions.crypt('TestPass!2026', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}',
      now(), now(), '', '', '', '', '', '', '', '');
    insert into auth.identities (id, user_id, provider, provider_id, identity_data, created_at, updated_at, last_sign_in_at)
    values (gen_random_uuid(), u.id, 'email', u.id::text, json_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true), now(), now(), now());
  end loop;
end $$;
insert into public.vendors (id, name, created_by) values
  ('33333333-0000-4000-8000-0000000000d2', 'D2', null),
  ('33333333-0000-4000-8000-000000000010', 'Rossi Plumbing (TEST)', null);
insert into public.profiles (id, user_id, display_name, role, vendor_id) values
  ('22222222-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001', 'Test Admin', 'admin', null),
  ('22222222-0000-4000-8000-000000000002', '11111111-0000-4000-8000-000000000002', 'Leo', 'vendor', '33333333-0000-4000-8000-0000000000d2'),
  ('22222222-0000-4000-8000-000000000003', '11111111-0000-4000-8000-000000000003', 'Sam', 'vendor', '33333333-0000-4000-8000-0000000000d2'),
  ('22222222-0000-4000-8000-000000000004', '11111111-0000-4000-8000-000000000004', 'Mike Rossi', 'vendor', '33333333-0000-4000-8000-000000000010'),
  ('22222222-0000-4000-8000-000000000005', null, 'Nina', 'vendor', '33333333-0000-4000-8000-0000000000d2');
insert into public.invite_codes (code, profile_id) values ('TST7-NNAD', '22222222-0000-4000-8000-000000000005');
insert into public.companies (id, name) values ('33333333-0000-4000-8000-000000000001', 'L&L Builders (TEST)');
insert into public.addresses (id, address, nicknames) values ('33333333-0000-4000-8000-000000000002', '123 Ocean Blvd, Boca Raton, FL (TEST)', '{Ocean}');
insert into public.punchlists (id, company_id, address_id) values ('33333333-0000-4000-8000-000000000003', '33333333-0000-4000-8000-000000000001', '33333333-0000-4000-8000-000000000002');
insert into public.items (id, punchlist_id, text, vendor_id, assignee_id) values
  ('44444444-0000-4000-8000-000000000001', '33333333-0000-4000-8000-000000000003', 'Frame closet opening', '33333333-0000-4000-8000-0000000000d2', null),
  ('44444444-0000-4000-8000-000000000002', '33333333-0000-4000-8000-000000000003', 'Hang master bath door', null, '22222222-0000-4000-8000-000000000002'),
  ('44444444-0000-4000-8000-000000000003', '33333333-0000-4000-8000-000000000003', 'Cap rough-in drain in master bath', '33333333-0000-4000-8000-000000000010', null),
  ('44444444-0000-4000-8000-000000000004', '33333333-0000-4000-8000-000000000003', 'Fix leak under kitchen sink', null, null);
insert into public.item_ccs (item_id, vendor_id) values ('44444444-0000-4000-8000-000000000003', '33333333-0000-4000-8000-0000000000d2');
