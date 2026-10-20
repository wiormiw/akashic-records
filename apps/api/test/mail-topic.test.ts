import { expect, test } from 'bun:test';
import { MAIL_TOPIC } from '@akashic/broker';
import { MAIL_REQUESTED } from '@akashic/contracts/events';

// The broker can't import contracts, so it spells the topic out; if they drift, dead mail
// (addresses, tokens) would silently stop being pruned. Only the API sees both packages.
test("the broker's mail topic is contracts' MAIL_REQUESTED", () => {
	expect(MAIL_TOPIC).toBe(MAIL_REQUESTED);
});
