import { beforeEach, describe, expect, test } from "bun:test";
import { silentLogger } from "@akashic/lib/log";
import { recordSpans } from "@akashic/lib/testing";
import { createEmbedder } from "@/integrations/embedder.ts";
import { createResendMailer } from "@/integrations/mail.ts";
import { createS3ImageStore } from "@/integrations/storage.ts";

const recorder = recordSpans();
const logger = silentLogger();
beforeEach(() => recorder.reset());

const named = (name: string) => recorder.spans().find((span) => span.name === name);

describe("spans on outgoing calls", () => {
  test("mail.send records whether a link was involved, never the recipient or content", async () => {
    const mailer = createResendMailer({
      apiKey: undefined,
      from: "Akashic <noreply@example.test>",
      timeoutMs: 1000,
      logLinks: false,
      logger,
      signal: new AbortController().signal,
    });
    await mailer.send({
      to: "someone@example.test",
      subject: "Confirm your secret subject",
      html: "<p>secret body</p>",
      link: "https://example.test/verify?token=abc",
    });

    const span = named("mail.send");
    expect(span?.attributes["akashic.mail.has_link"]).toBe(true);
    const attributes = JSON.stringify(span?.attributes);
    for (const secret of ["someone@example.test", "secret", "token=abc"]) {
      expect(attributes).not.toContain(secret);
    }
  });

  test("embedder.embed names the provider and model, and records a failed call", async () => {
    const embedder = createEmbedder({
      provider: "openai",
      apiKey: "k",
      // Nothing listens here, so fetch fails at once.
      baseUrl: "http://127.0.0.1:1",
      model: "embed-1",
      timeoutMs: 1000,
      attempts: 1,
      logger,
    });
    expect(await embedder.embed("a realm about robots")).toBeNull();

    const span = named("embedder.embed");
    expect(span?.attributes).toMatchObject({
      "akashic.ai.provider": "openai",
      "akashic.ai.model": "embed-1",
    });
    expect(span?.status.code).toBe(2);
    expect(JSON.stringify(span?.attributes)).not.toContain("robots");
  });

  test("storage.put is a span even when the store refuses for want of a bucket", async () => {
    const store = createS3ImageStore({
      bucket: undefined,
      region: "us-east-1",
      endpoint: undefined,
      publicUrl: undefined,
      accessKeyId: undefined,
      secretAccessKey: undefined,
      logger,
    });
    await expect(store.put(new Uint8Array([1]), "image/png", "avatars")).rejects.toThrow(
      "not configured",
    );
    expect(named("storage.put")?.status.code).toBe(2);
  });
});
