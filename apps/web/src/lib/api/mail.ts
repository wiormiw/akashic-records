import * as v from 'valibot';
import { API_BASE } from '$lib/config';

/**
 * Whether verification mail is currently getting out of the deployment.
 *
 * Read on the screens that ask someone to go and check their inbox, so those screens can stop
 * saying it when nothing was sent. It describes the deployment, never an address, so it is safe
 * to read while signed out — which is exactly when it matters.
 */
export const MailStatus = v.object({
	configured: v.boolean(),
	healthy: v.boolean(),
	lastFailure: v.nullable(v.string()),
	failedAt: v.nullable(v.string()),
});
export type MailStatus = v.InferOutput<typeof MailStatus>;

/**
 * Reads the deployment's mail status.
 *
 * @param options `fetch` to use — pass SvelteKit's during SSR.
 * @returns The status, or null when it cannot be read. Null means "no reason to warn", because a
 *   status check that is itself down is not evidence that mail is broken.
 *
 * @example
 * const mail = await mailStatus({ fetch });
 * if (mail && !mail.healthy) showDeliveryWarning();
 */
export async function mailStatus(
	options: { fetch?: typeof globalThis.fetch } = {},
): Promise<MailStatus | null> {
	const doFetch = options.fetch ?? globalThis.fetch;

	try {
		const response = await doFetch(`${API_BASE}/mail-status`);
		if (!response.ok) return null;

		const parsed = v.safeParse(MailStatus, await response.json());
		return parsed.success ? parsed.output : null;
	} catch {
		return null;
	}
}
