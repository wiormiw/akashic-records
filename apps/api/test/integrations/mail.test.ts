import { describe, expect, test } from "bun:test";
import { captureLogger } from "@akashic/lib/testing";
import { createResendMailer, recipientHash } from "@/integrations/mail.ts";

const TO = "someone@example.test";

/** A mailer whose provider answers with `answer`, logging into `logger`. */
function mailerAnswering(answer: () => Promise<unknown>) {
  const { logger, lines } = captureLogger();
  const mailer = createResendMailer({
    apiKey: "re_test",
    from: "Akashic <noreply@example.test>",
    timeoutMs: 1000,
    logLinks: false,
    logger,
    signal: new AbortController().signal,
    client: { emails: { send: answer } } as never,
  });
  return { mailer, lines };
}

const message = { to: TO, subject: "Hello", html: "<p>hi</p>" };

describe("mail logs", () => {
  test("the recipient hash is the first 12 hex characters of the address's SHA-256", () => {
    const full = new Bun.CryptoHasher("sha256").update(TO).digest("hex");
    expect(recipientHash(TO)).toBe(full.slice(0, 12));
    expect(recipientHash(TO)).toMatch(/^[0-9a-f]{12}$/);
  });

  test("a rejected message is logged at error with the hash, never the address", async () => {
    const { mailer, lines } = mailerAnswering(async () => ({ error: { message: "bad address" } }));
    await expect(mailer.send(message)).rejects.toThrow("could not be delivered");
    const line = lines.find((l) => l["msg"] === "resend rejected the message");
    expect(line).toMatchObject({ level: 50, recipient: recipientHash(TO) });
    expect(JSON.stringify(lines)).not.toContain(TO);
  });

  test("a failed delivery is logged with the hash, never the address", async () => {
    const { mailer, lines } = mailerAnswering(async () => {
      throw new Error("network down");
    });
    await expect(mailer.send(message)).rejects.toThrow("could not be delivered");
    const line = lines.find((l) => l["msg"] === "mail delivery failed");
    expect(line).toMatchObject({ level: 50, recipient: recipientHash(TO) });
    expect(JSON.stringify(lines)).not.toContain(TO);
  });
});
