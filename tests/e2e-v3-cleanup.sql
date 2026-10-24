-- Removes everything e2e-v3-seed.sql / e2e-v3.js created. Never touches real profiles or users.
delete from public.companies where id = '33333333-0000-4000-8000-000000000001' or name like '%(TEST)%'
  or created_by in (select id from auth.users where email like 'pl-test-%@example.invalid');
delete from public.addresses where id = '33333333-0000-4000-8000-000000000002' or address like '%(TEST)%'
  or created_by in (select id from auth.users where email like 'pl-test-%@example.invalid');
delete from public.vendors where id in ('33333333-0000-4000-8000-0000000000d2', '33333333-0000-4000-8000-000000000010')
  or name like '%(TEST)%' or created_by in (select id from auth.users where email like 'pl-test-%@example.invalid');
delete from public.profiles where id::text like '22222222-0000-4000-8000-%'
  or user_id in (select id from auth.users where email like 'pl-test-%@example.invalid')
  or id in (select profile_id from public.invite_codes where created_by in (select id from auth.users where email like 'pl-test-%@example.invalid'));
delete from auth.users where email like 'pl-test-%@example.invalid';
select (select count(*) from public.profiles) profiles, (select count(*) from public.vendors) vendors, (select count(*) from public.items) items,
       (select count(*) from public.companies) companies, (select count(*) from public.addresses) addresses,
       (select count(*) from public.invite_codes) codes, (select count(*) from public.notifications) notifs, (select count(*) from auth.users) users;
