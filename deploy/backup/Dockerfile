# The backup runner: the Postgres 17 client (pg_dump/pg_restore must match the server's major
# version) plus the MinIO client, and crond for the nightly run.
#
# mc is copied from Chainguard's build, since MinIO no longer publishes mc to Docker Hub. Pinned
# by digest alone: Chainguard's free images carry only `latest`. It is a static Go binary, so it
# runs on alpine's musl. Bump the digest here and on the `minio` service together.
FROM cgr.dev/chainguard/minio-client@sha256:b8b144ab34694ecea25aa352c4be9de4c26ee2a02701521dce02ee5593c57338 AS mc

FROM postgres:17-alpine
COPY --from=mc /usr/bin/mc /usr/local/bin/mc
COPY backup.sh restore.sh entrypoint.sh /backup/
RUN chmod 755 /backup/*.sh
ENV TZ=Asia/Jakarta
# The postgres image's entrypoint would start a server; this one starts the scheduler.
ENTRYPOINT ["/backup/entrypoint.sh"]
