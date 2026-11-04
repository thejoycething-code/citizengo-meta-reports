-- 37A + 37C (Priority Three follow-up, Chris 4 Nov 2026): Listening shows posts
-- as pictures. Only a link to the picture Meta already serves is kept, never a
-- copy, and it goes with its post row: opponent rows (and so their pictures)
-- are still deleted after 120 days by purge_opponent_data.
--
--   peer_ig_media.thumbnail_url  allies' and opponents' Instagram pictures, from
--                                the same nightly business_discovery call
--                                (media_url; a video's picture isn't offered).
--   meta_posts.picture_url       our own Facebook posts' picture, the full
--                                signed link (full_picture keeps only the path
--                                as an identity key). Refreshed every night for
--                                recent posts; old links expire, so the desk
--                                falls back to the words.
alter table public.peer_ig_media add column if not exists thumbnail_url text;
alter table public.meta_posts   add column if not exists picture_url  text;
