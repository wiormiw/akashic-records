# Plan 5 follow-ups

Deferred by the final whole-branch review of Plan 5 (deployment).

- **Make `authz-backfill` complete.** It rebuilds realm and membership tuples only. Posting
  tuples (`realm`, `author`) come from outbox events pruned after 7 days, and the platform
  `admin` lives only in OpenFGA. Backups now dump OpenFGA's database as a pair with the app's,
  which covers disk loss; extending backfill to postings and the platform admin, and having it
  clear tuples Postgres no longer holds, would cover restoring an app-only dump.
- **Keep `BACKUP_*` out of the API's environment.** The API reads the whole `.env`, so it holds
  the backup bucket's delete key. For now the bucket must have versioning or object lock
  (deploy/README.md, section 5). Splitting the env files changes the shape of the `API_ENV`
  secret, which is why it waits.
- **Encrypt dumps with `age`** before upload, if the provider's server-side encryption is not
  enough.
