import { RsvpStatus } from "@akashic/lib/enums";

/**
 * Whether one more RSVP of `status` fits. Only "going" takes a place, someone already going keeps
 * theirs, and an event without a capacity never fills.
 */
export function hasRoomFor(
  status: RsvpStatus,
  capacity: number | null,
  tally: { going: number; already: boolean } | undefined,
): boolean {
  if (status !== RsvpStatus.going || capacity === null || !tally) return true;
  return tally.already || Number(tally.going) < capacity;
}
