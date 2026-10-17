import { expect, test } from 'bun:test';
import { CommentSubject, RealmRole } from '@akashic/lib/enums';
import { assertTrue, type Equal } from '@akashic/lib/testing';
import type { SeatStanding, Takedown } from '../src/governance.ts';

// The contract's types are the enums, not `number`; the wire values are the enums' numbers.
test('a seat standing carries a RealmRole and a takedown a CommentSubject', () => {
	assertTrue<Equal<SeatStanding['role'], RealmRole>>();
	assertTrue<Equal<Takedown['subjectKind'], CommentSubject>>();
	expect(Object.values(RealmRole)).toEqual([0, 1, 2, 3]);
	expect(Object.values(CommentSubject)).toEqual([0, 1, 2]);
});
