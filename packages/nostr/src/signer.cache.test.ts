import { beforeEach, describe, expect, it, vi } from "vitest";

// Counts conversation-key derivations (an ECDH + HKDF each) without changing
// what they return.
const derive = vi.fn();
vi.mock("nostr-tools", async (importOriginal) => {
	const actual = await importOriginal<typeof import("nostr-tools")>();
	return {
		...actual,
		nip44: {
			...actual.nip44,
			getConversationKey: (secret: Uint8Array, pubkey: string) => {
				derive(pubkey);
				return actual.nip44.getConversationKey(secret, pubkey);
			},
		},
	};
});

import { generateSecretKey, getPublicKey } from "nostr-tools";
import { localSigner } from "./signer";

const HOT_PEER = getPublicKey(generateSecretKey());

beforeEach(() => {
	derive.mockClear();
});

describe("localSigner conversation-key cache", () => {
	it("keeps a hot peer's key while hundreds of one-time wrap keys pass through", async () => {
		// Gift wrapping means every inbound wrap is decrypted under a key that
		// never recurs, interleaved with the few senders whose seals we open
		// over and over. Flushing the whole cache when it fills — what it used
		// to do — threw the hot keys out with the one-time ones.
		const signer = localSigner(generateSecretKey());
		await signer.nip44Encrypt(HOT_PEER, "warm");
		for (let i = 0; i < 300; i++) {
			await signer.nip44Encrypt(getPublicKey(generateSecretKey()), "x");
			await signer.nip44Encrypt(HOT_PEER, "still hot");
		}
		const hotDerivations = derive.mock.calls.filter(
			([pubkey]) => pubkey === HOT_PEER,
		).length;
		expect(hotDerivations).toBe(1);
	});

	it("still bounds the cache: an idle key is eventually evicted and re-derived", async () => {
		const signer = localSigner(generateSecretKey());
		await signer.nip44Encrypt(HOT_PEER, "once");
		for (let i = 0; i < 300; i++) {
			await signer.nip44Encrypt(getPublicKey(generateSecretKey()), "x");
		}
		await signer.nip44Encrypt(HOT_PEER, "again");
		const hotDerivations = derive.mock.calls.filter(
			([pubkey]) => pubkey === HOT_PEER,
		).length;
		expect(hotDerivations).toBe(2);
	});
});
