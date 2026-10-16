import { Hono } from 'hono';
import * as v from 'valibot';
import {
	CommentBody,
	CommentView,
	Created,
	presentComment,
	RealmItemParam,
	RemovedView,
	SubjectParam,
	subjectOf,
} from '@akashic/contracts';
import { FgaType, Relation } from '@akashic/authz';
import { mapOk } from '@akashic/lib/result';
import { type AppEnv, callerOf } from '@/http/env.ts';
import { type RealmEnv, requireOn, requirePermission } from '@/http/realm-context.ts';
import { respond } from '@/http/reply.ts';
import { validate } from '@/http/validate.ts';
import type { ModuleRoutes } from '../module.ts';
import type { CommentsRoutesDeps } from './comments.types.ts';

export function createCommentsRoutes(deps: CommentsRoutesDeps): ModuleRoutes {
	const { comments, realmContext, authorizer } = deps;

	// Guards sit on each route, after its validation, never `use`d on a shared prefix.
	const privateRoutes = new Hono<RealmEnv>()
		.delete(
			'/realms/:slug/comments/:id',
			validate('param', RealmItemParam),
			realmContext,
			// Its author or a moderator of its realm (model.fga); the service still checks the comment
			// is this realm's, since a moderator elsewhere passes this check.
			requireOn(authorizer, Relation.comment.delete, FgaType.comment),
			async (c) =>
				respond(
					c,
					await comments.remove(c.var.realm.realmId, c.req.valid('param').id, callerOf(c).id),
					RemovedView,
				),
		)
		.get(
			'/realms/:slug/:kind/:id/comments',
			validate('param', SubjectParam),
			realmContext,
			requirePermission('participate'),
			async (c) =>
				respond(
					c,
					mapOk(
						await comments.thread(c.var.realm.realmId, subjectOf(c.req.valid('param'))),
						(thread) => thread.map(presentComment),
					),
					v.array(CommentView),
				),
		)
		.post(
			'/realms/:slug/:kind/:id/comments',
			validate('param', SubjectParam),
			validate('json', CommentBody),
			realmContext,
			requirePermission('participate'),
			async (c) =>
				respond(
					c,
					await comments.add(
						c.var.realm.realmId,
						subjectOf(c.req.valid('param')),
						callerOf(c).id,
						c.req.valid('json').body,
					),
					Created,
					201,
				),
		);

	return { private: new Hono<AppEnv>().route('/', privateRoutes) };
}
