/** NIP-AGX Nostr event kinds. */

/** Message/Task — the kind of the RUMOR inside a gift wrap: an unsigned event
 * whose `content` is the plaintext A2A payload. Never published bare. */
export const MESSAGE_KIND = 3838;
/** Receipt (delivery ack) — likewise only ever a gift-wrapped rumor. */
export const RECEIPT_KIND = 3839;
/** NIP-59 seal: the rumor, NIP-44-encrypted and signed by the real sender. */
export const SEAL_KIND = 13;
/** NIP-59 gift wrap: the seal, encrypted again and signed by a one-time key.
 * The only kind AGX messages and receipts travel as on a relay. */
export const GIFT_WRAP_KIND = 1059;
/** Agent Card — replaceable (10000–19999): latest per pubkey wins; UNENCRYPTED. */
export const CARD_KIND = 11_337;
/** NIP-65 relay-list metadata. */
export const RELAY_LIST_KIND = 10_002;
/** NIP-09 deletion request — asks relays to drop the referenced events. Used to
 * RETRACT a published Agent Card when an agent de-lists. Relays are not obliged
 * to honor it, so a retraction is best-effort by construction. */
export const DELETION_KIND = 5;
