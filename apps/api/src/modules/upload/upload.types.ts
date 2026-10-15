import type { Limits } from "@akashic/contracts";
import type { Logger } from "@akashic/lib/log";
import type { RateLimiter } from "@/integrations/rate-limit.ts";
import type { ImageStore } from "@/integrations/storage.ts";
import type { UploadService } from "./upload.service.ts";

export interface UploadDeps {
  store: ImageStore;
}

/** What the uploads routes are built from. */
export interface UploadRoutesDeps {
  uploads: UploadService;
  limiter: RateLimiter;
  trustProxy: boolean;
  logger: Logger;
}

/** What the upload module is built from: just what its routes need. */
export type UploadModuleDeps = UploadRoutesDeps;

/** What the service answers about the deployment. */
export type UploadLimits = Limits;
