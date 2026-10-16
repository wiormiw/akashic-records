import type { Module } from '../module.ts';
import { createFitService } from './postings.fit.service.ts';
import { createInterestService } from './postings.interest.service.ts';
import { createJobService } from './postings.jobs.service.ts';
import { createListingService } from './postings.listings.service.ts';
import { createPostingsRoutes } from './postings.routes.ts';
import type { PostingServices, PostingsDeps, PostingsModuleDeps } from './postings.types.ts';

/** The postings services, built once: jobs and listings post through the fit check. */
export function createPostingServices(deps: PostingsDeps): PostingServices {
	const fit = createFitService(deps);
	return {
		fit,
		interest: createInterestService({ db: deps.db, clock: deps.clock }),
		jobs: createJobService({ db: deps.db, clock: deps.clock, fit }),
		listings: createListingService({ db: deps.db, clock: deps.clock, fit }),
	};
}

/** Jobs and listings: posting, realm fit, interest, hiring and deals. */
export function createPostingsModule(deps: PostingsModuleDeps): Module {
	return { name: 'postings', routes: createPostingsRoutes(deps) };
}
