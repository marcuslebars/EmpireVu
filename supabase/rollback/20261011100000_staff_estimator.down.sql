-- Rollback for 20261011100000_staff_estimator.sql (the AI estimator).
-- Photos already stored in the quote-photos bucket are NOT deleted here (storage objects are
-- removed through the Storage API); the bucket row stays if it still holds objects.
drop policy if exists "quote_photos_members_read" on storage.objects;
delete from storage.buckets b
  where b.id = 'quote-photos'
    and not exists (select 1 from storage.objects o where o.bucket_id = 'quote-photos');

drop index if exists public.quotes_front_desk_follow_up_idx;
drop table if exists public.quote_follow_ups;
drop table if exists public.estimate_requests;
