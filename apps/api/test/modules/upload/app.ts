import type { Executor } from "@akashic/db";
import { createMemoryCounters } from "@/integrations/counters.ts";
import { createRateLimiter } from "@/integrations/rate-limit.ts";
import type { ImageStore } from "@/integrations/storage.ts";
import { silentLogger } from "@akashic/lib/log";
import { createUploadRoutes } from "@/modules/upload/upload.routes.ts";
import { createUploadService } from "@/modules/upload/upload.service.ts";
import { testApp } from "../../support/app.ts";

/** The upload routes mounted as app.ts mounts them, over `store`, with a fresh hourly budget. */
export const uploadApp = (db: Executor, store: ImageStore) =>
  testApp(db, {
    routes: () =>
      createUploadRoutes({
        uploads: createUploadService({ store }),
        limiter: createRateLimiter({ counters: createMemoryCounters() }),
        trustProxy: false,
        logger: silentLogger(),
      }),
  });
