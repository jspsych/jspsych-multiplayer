/**
 * The group session key under which a member whose seal JATOS confirmed publishes the final
 * roster, so the rest of the group learns about the seal. Participant IDs can't contain `$`, so
 * it never collides with one, and getAll() leaves out every key that starts with `$`.
 */
export const SEALED_KEY = "$sealed";
