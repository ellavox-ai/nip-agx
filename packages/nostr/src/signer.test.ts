import {
	generateSecretKey,
	getPublicKey,
	nip44,
	verifyEvent,
} from "nostr-tools";
import { describe, expect, it } from "vitest";
import { MESSAGE_KIND } from "./kinds";
import { type AgxSigner, localSigner } from "./signer";

const aliceSecret = generateSecretKey();
const bobSecret = generateSecretKey();
const ALICE = getPublicKey(aliceSecret);
const BOB = getPublicKey(bobSecret);

describe("localSigner", () => {
	it("reports the key's own public key", async () => {
		await expect(localSigner(aliceSecret).getPublicKey()).resolves.toBe(
			ALICE,
		);
	});

	it("signs a verifiable event as that key", async () => {
		const event = await localSigner(aliceSecret).signEvent({
			kind: 1,
			created_at: 1000,
			tags: [],
			content: "hi",
		});
		expect(event.pubkey).toBe(ALICE);
		expect(verifyEvent(event)).toBe(true);
	});

	it("round-trips NIP-44 between two signers", async () => {
		const ciphertext = await localSigner(aliceSecret).nip44Encrypt(
			BOB,
			"secret",
		);
		await expect(
			localSigner(bobSecret).nip44Decrypt(ALICE, ciphertext),
		).resolves.toBe("secret");
	});

	it("is wire-compatible with nostr-tools' NIP-44 directly", async () => {
		// A peer on plain nostr-tools must be able to read what we produce.
		const ciphertext = await localSigner(aliceSecret).nip44Encrypt(
			BOB,
			"interop",
		);
		const key = nip44.getConversationKey(bobSecret, ALICE);
		expect(nip44.decrypt(ciphertext, key)).toBe("interop");
	});

	it("rejects (not throws) on a ciphertext it cannot open", async () => {
		// Callers `await` inside try/catch; a synchronous throw from a promise-
		// returning method would escape that shape in some call sites.
		const signer = localSigner(bobSecret);
		let threw = false;
		const pending = (() => {
			try {
				return signer.nip44Decrypt(ALICE, "not-a-payload");
			} catch {
				threw = true;
				return Promise.resolve("");
			}
		})();
		expect(threw).toBe(false);
		await expect(pending).rejects.toThrow();
	});
});

describe("a signer that holds no key material", () => {
	it("is enough to build an AGX event — the shape a NIP-46 bunker satisfies", async () => {
		// Delegates to a key held "elsewhere" through the interface only. If any
		// code path needed the raw secret, this signer could not serve it.
		const remote = localSigner(aliceSecret);
		const bunker: AgxSigner = {
			getPublicKey: () => remote.getPublicKey(),
			signEvent: (t) => remote.signEvent(t),
			nip44Encrypt: (pk, pt) => remote.nip44Encrypt(pk, pt),
			nip44Decrypt: (pk, ct) => remote.nip44Decrypt(pk, ct),
		};
		const event = await bunker.signEvent({
			kind: MESSAGE_KIND,
			created_at: 1000,
			tags: [["p", BOB]],
			content: await bunker.nip44Encrypt(BOB, "{}"),
		});
		expect(verifyEvent(event)).toBe(true);
		expect(event.pubkey).toBe(ALICE);
	});
});
