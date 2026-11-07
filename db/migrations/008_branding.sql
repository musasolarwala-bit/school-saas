-- 008_branding.sql — Phase 1: per-school branding.
-- display_name / logo_url / tagline are nullable (the school's legal
-- `name` stays the fallback); primary_color always has a value and is
-- validated as a #RRGGBB hex string by the settings route.
-- These fields are the ONLY school fields the unauthenticated public
-- branding endpoint may return (see server/routes/public.js).

ALTER TABLE schools ADD COLUMN display_name TEXT;
ALTER TABLE schools ADD COLUMN logo_url TEXT;
ALTER TABLE schools ADD COLUMN primary_color TEXT NOT NULL DEFAULT '#1d6fb8';
ALTER TABLE schools ADD COLUMN tagline TEXT;
