import * as v from 'valibot';

/** What `GET /mail-status` answers, so sign-up can warn when mail is down. */
export const MailStatusView = v.object({
	configured: v.boolean(),
	healthy: v.boolean(),
	lastFailure: v.nullable(v.string()),
	failedAt: v.nullable(v.string()),
});
