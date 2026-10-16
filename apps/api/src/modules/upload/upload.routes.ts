import { Hono } from 'hono';
import { LimitsView, PurposeParam, UploadedView, uploadBody } from '@akashic/contracts';
import type { AppEnv } from '@/http/env.ts';
import { rateLimit } from '@/http/rate-limit.ts';
import { reply, respond } from '@/http/reply.ts';
import { bodyCeiling } from '@/http/security.ts';
import { validate } from '@/http/validate.ts';
import { policy, UPLOAD_BODY_BYTES } from '@/config.ts';
import type { ModuleRoutes } from '../module.ts';
import type { UploadRoutesDeps } from './upload.types.ts';

const UploadBody = uploadBody(policy.uploads);

export function createUploadRoutes(deps: UploadRoutesDeps): ModuleRoutes {
	const { uploads } = deps;
	// Both routes share the hourly budget. On the upload it follows validation, as the old guard
	// did, so a refused file spends none of it.
	const limited = rateLimit(
		deps.limiter,
		{ bucket: 'upload', limit: policy.uploads.perHour, windowSeconds: 3600 },
		{ trustProxy: deps.trustProxy, logger: deps.logger },
	);

	const privateRoutes = new Hono<AppEnv>()
		.get('/uploads', limited, (c) => reply(c, LimitsView, uploads.limits()))
		.post(
			'/uploads/:purpose',
			// Before the form is parsed, so an oversized body is refused before it is buffered whole.
			bodyCeiling(UPLOAD_BODY_BYTES),
			validate('param', PurposeParam),
			validate('form', UploadBody),
			limited,
			async (c) =>
				respond(
					c,
					await uploads.acceptImage(c.req.valid('form').file, c.req.valid('param').purpose),
					UploadedView,
					201,
				),
		);

	return { private: privateRoutes };
}
