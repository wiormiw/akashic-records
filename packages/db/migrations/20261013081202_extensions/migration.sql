-- drizzle-kit emits citext, vector and gin_trgm_ops but never creates their extensions.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
