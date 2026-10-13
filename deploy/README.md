# Deploying

Two API pods, two web pods, one migration Job, a log agent on every node, and the infrastructure
they depend on.

## Order, which matters

`kubectl apply` does not wait for anything, so the schema has to land before the code that reads
it:

```sh
kubectl apply -f deploy/k8s/00-config.yaml
kubectl -n akashic apply -f deploy/k8s/10-migrate.yaml
kubectl -n akashic wait --for=condition=complete job/migrate --timeout=5m
kubectl -n akashic apply -f deploy/k8s/20-api.yaml -f deploy/k8s/30-web.yaml
kubectl -n akashic apply -f deploy/k8s/40-log-agent.yaml
```

The wait is the only step somebody skips, and skipping it is how a pod boots against a schema that
has not been altered yet. Under Helm this becomes a `pre-upgrade` hook and the ordering is
automatic; there is no chart yet, and an undocumented ordering requirement is one that gets missed
at 2am.

## What is not in here

**Infrastructure.** Postgres, Redis, OpenFGA, and the telemetry Collector with its backends are
dependencies, not deliverables. `compose.yaml`
stands them up for development; production should use whatever the platform offers as a managed
service, because operating a database is a different job from writing one.

**Secrets.** `00-config.yaml` declares the shape of `api-secrets` with every value empty. That is
deliberate: it documents what the API refuses to start without, so a missing key is found by
reading a file rather than by watching a pod crash-loop. Fill it from a real secret manager.
Placeholder values would be worse than blanks, because placeholders get deployed.

**An ingress.** Routing and TLS depend on the controller in front, and a guess here would be
wrong in a way that looks authoritative.

**A registry.** CI builds both images and pushes neither. When a registry exists, the build steps
gain `push: true` and a login, and nothing else changes.

## Why two replicas is safe

Not a default — it is the number the design was checked against. Sessions live in Postgres. Rate
limit counters live in Redis, and degrade to per-process when it is unavailable, which means the
effective limit doubles across two pods during a Redis outage. Outbox claiming is a guarded
`UPDATE`, so two dispatchers cannot take the same message and neither pod restarting pauses
delivery.

Room messages were the one thing that was not safe. Fan-out used Bun's own pub/sub and a topic
lives inside one process, so two participants whose sockets landed on different pods never saw
each other's messages until a page reload — silently, because the message was still stored. A
Redis channel now carries them between instances (`platform/relay.ts`).

## Logs

The API writes JSON to stdout and nothing else. `40-log-agent.yaml` runs a Collector on each node
that reads this namespace's pod logs from `/var/log/pods` and forwards them over OTLP to
`otel-collector`, the same address the API sends traces and metrics to. A DaemonSet rather than a
sidecar: a sidecar only helps a process that logs to a file inside its container. The agent runs
as root to read the kubelet's root-only log files, and assumes containerd or CRI-O.

## Configuration traps

**`CORS_ORIGINS` is comma-separated, not a JSON array.** A bracketed value is one origin that
matches nothing, and sign-in fails as a CORS refusal.

**`AI_TIMEOUT_MS` must be below `REQUEST_TIMEOUT_MS`.** The API refuses to start otherwise.

**`PUBLIC_API_BASE` is a build argument, not a runtime variable.** SvelteKit inlines `PUBLIC_`
values into the client bundle, so a value set at runtime cannot reach code already in a browser.
An image is built for the origin it will serve. `API_BASE` in `30-web.yaml` is the separate,
runtime, server-to-server address.

**`TRUST_PROXY` must be true behind an ingress.** Left false, the rate limiter buckets every
request in the cluster under the ingress controller's own address, which is one bucket for
everybody.

## What has and has not been verified

Verified: the manifests parse, and every document declares the kind, name and namespace it claims.
The images build. The relay carries a message between two processes.

Not verified: none of this has been applied to a cluster. `kubeconform` in CI checks the manifests
against the published schemas, which catches a misspelled field — the class of mistake that
otherwise applies cleanly and leaves a pod with no probe rather than an error. It does not catch a
wrong image name, an unreachable service address, or a resource request the cluster cannot satisfy.
The first apply will find those, and it should be to a staging namespace.
