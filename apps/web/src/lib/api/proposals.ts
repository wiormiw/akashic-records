import * as v from 'valibot';
import { ProposalView } from '@akashic/contracts';
import { ProposalStatus } from '@akashic/lib/enums';

/**
 * Asking to found a realm, and hearing back.
 *
 * Realms are no longer created on demand: an empty realm is worse than no realm, and a directory
 * of one-member communities teaches a visitor the place is dead. A proposal costs a few sentences
 * about who it is for, and an administrator approves or refuses with a reason the proposer reads.
 */

/** What each status is called in the interface. */
export const PROPOSAL_STATUS_LABEL: Record<ProposalStatus, string> = {
	[ProposalStatus.pending]: 'Waiting for a decision',
	[ProposalStatus.approved]: 'Approved',
	[ProposalStatus.rejected]: 'Not approved',
};

/** A request to found a realm, and what came of it. */
export const Proposal = ProposalView;
export type Proposal = v.InferOutput<typeof Proposal>;

/** What a proposal asks for. */
export interface NewProposal {
	slug: string;
	name: string;
	description?: string;
	category?: string;
	modules: number[];
	rationale: string;
}

/** Reads one endpoint, or null on any refusal. */
async function read<T extends v.GenericSchema>(
	path: string,
	schema: T,
	doFetch: typeof globalThis.fetch,
): Promise<v.InferOutput<T> | null> {
	try {
		const response = await doFetch(`/bff/api/v1${path}`, {
			headers: { accept: 'application/json' },
		});

		if (!response.ok) return null;

		const parsed = v.safeParse(schema, await response.json());
		return parsed.success ? parsed.output : null;
	} catch {
		return null;
	}
}

/** Sends one request, surfacing the API's own wording on refusal. */
async function write(path: string, body?: unknown): Promise<unknown> {
	const response = await fetch(`/bff/api/v1${path}`, {
		method: 'POST',
		headers: body
			? { 'content-type': 'application/json', accept: 'application/json' }
			: { accept: 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
	});

	const payload = await response.json().catch(() => null);

	if (!response.ok) {
		throw new Error(payload?.detail ?? `That did not work (${response.status}).`);
	}

	return payload;
}

/** What this caller has asked for, newest first. */
export const getMyProposals = (doFetch: typeof globalThis.fetch): Promise<Proposal[] | null> =>
	read('/proposals/mine', v.array(Proposal), doFetch);

/** The queue an administrator works, oldest first. */
export const getPendingProposals = (doFetch: typeof globalThis.fetch): Promise<Proposal[] | null> =>
	read('/admin/proposals', v.array(Proposal), doFetch);

/** Files a request to found a realm. One pending at a time, per account. */
export const propose = (proposal: NewProposal): Promise<unknown> => write('/proposals', proposal);

/** Approves one and founds the realm, with the proposer as its administrator. */
export const approveProposal = (id: string): Promise<unknown> =>
	write(`/admin/proposals/${id}/approve`);

/** Refuses one. The note is required and the proposer reads it. */
export const rejectProposal = (id: string, note: string): Promise<unknown> =>
	write(`/admin/proposals/${id}/reject`, { note });
