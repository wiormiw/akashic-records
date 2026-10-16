import { Hono } from 'hono';
import * as v from 'valibot';
import { FgaType, Relation } from '@akashic/authz';
import {
	Created,
	CreateJobBody,
	CreateListingBody,
	DealBody,
	DealtView,
	FitDecisionBody,
	FitDecisionView,
	FitReviewView,
	HireBody,
	HiredView,
	InterestBody,
	InterestView,
	JobStatusBody,
	JobStatusView,
	JobSummaryView,
	JobView,
	ListingStatusBody,
	ListingStatusView,
	ListingSummaryView,
	ListingView,
	ListPostingsQuery,
	presentFitReview,
	presentInterest,
	presentJob,
	presentJobSummary,
	presentListing,
	presentListingSummary,
	RealmItemParam,
	SubjectParam,
	subjectOf,
	WithdrawnView,
} from '@akashic/contracts';
import { RealmModule } from '@akashic/lib/enums';
import { mapOk } from '@akashic/lib/result';
import { type AppEnv, callerOf } from '@/http/env.ts';
import {
	type RealmEnv,
	requireModule,
	requireOn,
	requirePermission,
} from '@/http/realm-context.ts';
import { reply, respond } from '@/http/reply.ts';
import { validate } from '@/http/validate.ts';
import type { ModuleRoutes } from '../module.ts';
import type { PostingsRoutesDeps } from './postings.types.ts';

const jobsModule = requireModule(RealmModule.jobs);
const marketModule = requireModule(RealmModule.market);

export function createPostingsRoutes(deps: PostingsRoutesDeps): ModuleRoutes {
	const { postings, realmContext, authorizer } = deps;
	const may = (relation: string, type: FgaType) => requireOn(authorizer, relation, type);

	// Guards sit on each route, after its validation, never `use`d on a shared prefix.
	const publicRoutes = new Hono<RealmEnv>()
		.get(
			'/realms/:slug/jobs',
			validate('query', ListPostingsQuery),
			realmContext,
			jobsModule,
			async (c) => {
				const { show, limit } = c.req.valid('query');
				const list = await postings.jobs.browse(c.var.realm.realmId, show === 'open', limit);
				return reply(c, v.array(JobSummaryView), list.map(presentJobSummary));
			},
		)
		.get(
			'/realms/:slug/listings',
			validate('query', ListPostingsQuery),
			realmContext,
			marketModule,
			async (c) => {
				const { show, limit } = c.req.valid('query');
				const list = await postings.listings.browse(c.var.realm.realmId, show === 'open', limit);
				return reply(c, v.array(ListingSummaryView), list.map(presentListingSummary));
			},
		);

	const privateRoutes = new Hono<RealmEnv>()
		.get('/realms/:slug/review', realmContext, requirePermission('moderate'), async (c) =>
			reply(
				c,
				v.array(FitReviewView),
				(await postings.fit.reviewQueue(c.var.realm.realmId)).map(presentFitReview),
			),
		)
		.post(
			'/realms/:slug/review/:id',
			validate('param', RealmItemParam),
			validate('json', FitDecisionBody),
			realmContext,
			requirePermission('moderate'),
			async (c) =>
				respond(
					c,
					await postings.fit.decide(
						c.var.realm.realmId,
						c.req.valid('param').id,
						callerOf(c).id,
						c.req.valid('json').kept,
					),
					FitDecisionView,
				),
		)
		.get(
			'/realms/:slug/jobs/:id',
			validate('param', RealmItemParam),
			realmContext,
			requirePermission('participate'),
			async (c) =>
				respond(
					c,
					mapOk(
						await postings.jobs.read(c.var.realm.realmId, c.req.valid('param').id, callerOf(c).id),
						presentJob,
					),
					JobView,
				),
		)
		.post(
			'/realms/:slug/jobs',
			validate('json', CreateJobBody),
			realmContext,
			jobsModule,
			requirePermission('postJob'),
			async (c) =>
				respond(
					c,
					await postings.jobs.post({
						...c.req.valid('json'),
						realmId: c.var.realm.realmId,
						authorId: callerOf(c).id,
					}),
					Created,
					201,
				),
		)
		.patch(
			'/realms/:slug/jobs/:id',
			validate('param', RealmItemParam),
			validate('json', JobStatusBody),
			realmContext,
			may(Relation.posting.edit, FgaType.job),
			async (c) =>
				respond(
					c,
					await postings.jobs.setStatus(
						c.var.realm.realmId,
						c.req.valid('param').id,
						callerOf(c).id,
						c.req.valid('json').status,
					),
					JobStatusView,
				),
		)
		.post(
			'/realms/:slug/jobs/:id/hire',
			validate('param', RealmItemParam),
			validate('json', HireBody),
			realmContext,
			may(Relation.posting.settle, FgaType.job),
			async (c) =>
				respond(
					c,
					await postings.jobs.hire(
						c.var.realm.realmId,
						c.req.valid('param').id,
						callerOf(c).id,
						c.req.valid('json').userId,
					),
					HiredView,
				),
		)
		.get(
			'/realms/:slug/listings/:id',
			validate('param', RealmItemParam),
			realmContext,
			requirePermission('participate'),
			async (c) =>
				respond(
					c,
					mapOk(
						await postings.listings.read(
							c.var.realm.realmId,
							c.req.valid('param').id,
							callerOf(c).id,
						),
						presentListing,
					),
					ListingView,
				),
		)
		.post(
			'/realms/:slug/listings',
			validate('json', CreateListingBody),
			realmContext,
			marketModule,
			requirePermission('post'),
			async (c) =>
				respond(
					c,
					await postings.listings.post({
						...c.req.valid('json'),
						realmId: c.var.realm.realmId,
						sellerId: callerOf(c).id,
					}),
					Created,
					201,
				),
		)
		.patch(
			'/realms/:slug/listings/:id',
			validate('param', RealmItemParam),
			validate('json', ListingStatusBody),
			realmContext,
			may(Relation.posting.edit, FgaType.listing),
			async (c) =>
				respond(
					c,
					await postings.listings.setStatus(
						c.var.realm.realmId,
						c.req.valid('param').id,
						callerOf(c).id,
						c.req.valid('json').status,
						c.var.realm.permissions.moderate,
					),
					ListingStatusView,
				),
		)
		.post(
			'/realms/:slug/listings/:id/deal',
			validate('param', RealmItemParam),
			validate('json', DealBody),
			realmContext,
			may(Relation.posting.settle, FgaType.listing),
			async (c) =>
				respond(
					c,
					await postings.listings.deal(
						c.var.realm.realmId,
						c.req.valid('param').id,
						callerOf(c).id,
						c.req.valid('json').buyerId,
					),
					DealtView,
				),
		)
		.post(
			'/realms/:slug/:kind/:id/interest',
			validate('param', SubjectParam),
			validate('json', InterestBody),
			realmContext,
			requirePermission('participate'),
			async (c) =>
				respond(
					c,
					await postings.interest.show(
						c.var.realm.realmId,
						subjectOf(c.req.valid('param')),
						callerOf(c).id,
						c.req.valid('json').note,
					),
					Created,
					201,
				),
		)
		.delete(
			'/realms/:slug/:kind/:id/interest',
			validate('param', SubjectParam),
			realmContext,
			requirePermission('participate'),
			async (c) =>
				respond(
					c,
					await postings.interest.drop(
						c.var.realm.realmId,
						subjectOf(c.req.valid('param')),
						callerOf(c).id,
					),
					WithdrawnView,
				),
		)
		.get(
			'/realms/:slug/:kind/:id/interest',
			validate('param', SubjectParam),
			realmContext,
			requirePermission('participate'),
			async (c) =>
				respond(
					c,
					mapOk(
						await postings.interest.list(
							c.var.realm.realmId,
							subjectOf(c.req.valid('param')),
							callerOf(c).id,
							c.var.realm.permissions.moderate,
						),
						(interests) => interests.map(presentInterest),
					),
					v.array(InterestView),
				),
		);

	// Mounted as plain app routes: the realm variable exists only after the guards on each route.
	return {
		public: new Hono<AppEnv>().route('/', publicRoutes),
		private: new Hono<AppEnv>().route('/', privateRoutes),
	};
}
