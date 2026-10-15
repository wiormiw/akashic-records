import type { Uploaded, UploadPurpose } from "@akashic/contracts";
import { ErrorCode, fail } from "@akashic/lib/errors";
import { err, ok, type Result } from "@akashic/lib/result";
import { policy } from "@/config.ts";
import type { ImageType } from "@/integrations/storage.ts";
import type { UploadDeps, UploadLimits } from "./upload.types.ts";

const { maxBytes } = policy.uploads;

// Judged by the bytes, not the declared type or the file name, which the client chooses.
const SIGNATURES: { type: ImageType; matches: (b: Uint8Array) => boolean }[] = [
  { type: "image/jpeg", matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    type: "image/png",
    matches: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    type: "image/webp",
    matches: (b) =>
      String.fromCharCode(...b.subarray(0, 4)) === "RIFF" &&
      String.fromCharCode(...b.subarray(8, 12)) === "WEBP",
  },
];

const sniff = (bytes: Uint8Array) => SIGNATURES.find((signature) => signature.matches(bytes))?.type;

export function createUploadService(deps: UploadDeps) {
  const { store } = deps;

  return {
    limits: (): UploadLimits => ({
      enabled: store.configured,
      imageTypes: [...policy.uploads.imageTypes],
      maxBytes,
    }),

    async acceptImage(file: File, purpose: UploadPurpose): Promise<Result<Uploaded>> {
      if (!store.configured) {
        return err(
          fail.external(
            ErrorCode.external.storageNotConfigured,
            "This deployment stores no uploads. Paste an image URL instead.",
          ),
        );
      }
      if (file.size > maxBytes) {
        return err(
          fail.validation(
            ErrorCode.common.payloadTooLarge,
            `That file is larger than ${maxBytes / 1024 / 1024} MB.`,
          ),
        );
      }
      if (file.size === 0)
        return err(fail.validation(ErrorCode.common.validation, "That file is empty."));

      const bytes = new Uint8Array(await file.arrayBuffer());
      const type = sniff(bytes);
      if (!type) {
        return err(
          fail.validation(ErrorCode.common.validation, "That is not a JPEG, PNG or WebP image."),
        );
      }

      return ok({ url: await store.put(bytes, type, purpose) });
    },
  };
}

export type UploadService = ReturnType<typeof createUploadService>;
