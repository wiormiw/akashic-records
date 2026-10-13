import type { Logger } from "@akashic/lib/log";
import { traced } from "@akashic/lib/tracing";

export type ImageType = "image/jpeg" | "image/png" | "image/webp";

/** Public object storage for user images. */
export interface ImageStore {
  readonly configured: boolean;
  /** Stores the bytes under `prefix/` and returns the public URL. */
  put(bytes: Uint8Array, type: ImageType, prefix: string): Promise<string>;
}

export interface S3Options {
  bucket: string | undefined;
  region: string;
  endpoint: string | undefined;
  /** Where browsers fetch objects from; defaults to `endpoint/bucket`. */
  publicUrl: string | undefined;
  accessKeyId: string | undefined;
  secretAccessKey: string | undefined;
  logger: Logger;
}

/** An S3-compatible bucket (S3, R2, MinIO). Unconfigured without a bucket name. */
export function createS3ImageStore(options: S3Options): ImageStore {
  const { bucket } = options;
  if (!bucket) {
    return {
      configured: false,
      put: () =>
        traced("storage.put", { "akashic.storage.bucket": "" }, () =>
          Promise.reject(new Error("object storage is not configured")),
        ),
    };
  }

  const log = options.logger.child({ component: "storage" });
  const client = new Bun.S3Client({
    bucket,
    region: options.region,
    endpoint: options.endpoint,
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
  });
  const base = (options.publicUrl ?? `${options.endpoint ?? ""}/${bucket}`).replace(/\/$/, "");

  return {
    configured: true,
    put: (bytes, type, prefix) =>
      traced("storage.put", { "akashic.storage.bucket": bucket }, async () => {
        const key = `${prefix}/${Bun.randomUUIDv7()}.${type.slice("image/".length)}`;
        await client.write(key, bytes, { type });
        log.debug({ key, bytes: bytes.byteLength }, "stored object");
        return `${base}/${key}`;
      }),
  };
}
