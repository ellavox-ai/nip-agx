import {
	type Event,
	finalizeEvent,
	generateSecretKey,
	getEventHash,
	getPublicKey,
	nip44,
	verifyEvent,
} from "nostr-tools";
import { getPow } from "nostr-tools/nip13";
import { describe, expect, it, vi } from "vitest";
import {
	openMessageEvent,
	openReceiptEvent,
	signMessageEvent,
	signReceiptEvent,
} from "./events";
import {
	AGX_POW_BITS,
	createRumor,
	eventExpiration,
	MAX_EXPIRATION_SEC,
	MAX_WRAP_BACKDATE_SEC,
	unwrapRumor,
	WRAP_TTL_SEC,
	wrapRumor,
} from "./giftwrap";
import { GIFT_WRAP_KIND, MESSAGE_KIND, RECEIPT_KIND, SEAL_KIND } from "./kinds";
import { localSigner } from "./signer";

const senderSecret = generateSecretKey();
const recipientSecret = generateSecretKey();
const SENDER = getPublicKey(senderSecret);
const RECIPIENT = getPublicKey(recipientSecret);
const sender = localSigner(senderSecret);
const recipient = localSigner(recipientSecret);
const NOW = 1_800_000_000;

function tag(event: Event, name: string): string[] | undefined {
	return event.tags.find((t) => t[0] === name);
}

async function sendHello() {
	return signMessageEvent({
		signer: sender,
		recipientPubkey: RECIPIENT,
		text: "hello",
		nowSec: NOW,
	});
}

describe("gift-wrapped messages (NIP-59)", () => {
	it("round-trips: the recipient opens it and learns the REAL sender", async () => {
		const { event, rumorId } = await sendHello();
		const opened = await openMessageEvent({ signer: recipient, event });
		expect(opened?.text).toBe("hello");
		expect(opened?.senderPubkey).toBe(SENDER);
		expect(opened?.eventId).toBe(rumorId);
		expect(opened?.sentAt).toBe(NOW);
		expect(opened?.createdAt).toBe(event.created_at);
	});

	it("reveals only the recipient: kind 1059, a one-time signer, no content-type", async () => {
		const { event } = await sendHello();
		expect(event.kind).toBe(GIFT_WRAP_KIND);
		expect(verifyEvent(event)).toBe(true);
		expect(event.pubkey).not.toBe(SENDER);
		expect(tag(event, "p")?.[1]).toBe(RECIPIENT);
		// The rumor's tags stay inside: nothing on the outside says this is an
		// AGX message, let alone what kind of payload it carries.
		expect(tag(event, "content-type")).toBeUndefined();
		expect(event.tags.map((t) => t[0]).sort()).toEqual([
			"expiration",
			"nonce",
			"p",
		]);
	});

	it("uses a fresh one-time key per wrap", async () => {
		const a = await sendHello();
		const b = await sendHello();
		expect(a.event.pubkey).not.toBe(b.event.pubkey);
	});

	it("backdates the wrap within MAX_WRAP_BACKDATE_SEC, never forward", async () => {
		for (let i = 0; i < 20; i++) {
			const { event } = await sendHello();
			expect(event.created_at).toBeLessThanOrEqual(NOW);
			expect(event.created_at).toBeGreaterThan(
				NOW - MAX_WRAP_BACKDATE_SEC,
			);
		}
	});

	it("is unreadable by anyone but the recipient", async () => {
		const { event } = await sendHello();
		const stranger = localSigner(generateSecretKey());
		expect(await openMessageEvent({ signer: stranger, event })).toBeNull();
		// Nor by the sender: the wrap is encrypted to the recipient only.
		expect(await openMessageEvent({ signer: sender, event })).toBeNull();
	});

	it("keeps the rumor id when the SAME rumor is re-wrapped (a retry)", async () => {
		// The recipient dedupes on the rumor id, so a sender that re-publishes a
		// message after a failure must not look like a second message.
		const rumor = createRumor({
			pubkey: SENDER,
			kind: MESSAGE_KIND,
			tags: [["p", RECIPIENT]],
			content: "{}",
			nowSec: NOW,
		});
		const first = await wrapRumor({
			signer: sender,
			rumor,
			recipientPubkey: RECIPIENT,
			nowSec: NOW,
		});
		const second = await wrapRumor({
			signer: sender,
			rumor,
			recipientPubkey: RECIPIENT,
			nowSec: NOW,
		});
		expect(first.id).not.toBe(second.id);
		const a = await unwrapRumor({ signer: recipient, event: first });
		const b = await unwrapRumor({ signer: recipient, event: second });
		expect(a?.rumor.id).toBe(rumor.id);
		expect(b?.rumor.id).toBe(rumor.id);
	});

	it("wraps receipts too, correlated by the message's RUMOR id", async () => {
		const { rumorId } = await sendHello();
		const { event } = await signReceiptEvent({
			signer: recipient,
			recipientPubkey: SENDER,
			refEventId: rumorId,
			contextId: "ctx",
			status: "delivered",
			nowSec: NOW,
		});
		expect(event.kind).toBe(GIFT_WRAP_KIND);
		const opened = await openReceiptEvent({ signer: sender, event });
		expect(opened?.senderPubkey).toBe(RECIPIENT);
		expect(opened?.receipt.refEventId).toBe(rumorId);
		// A receipt is not mistaken for a message, nor the reverse.
		expect(await openMessageEvent({ signer: sender, event })).toBeNull();
	});
});

/** Hand-build a wrap around an arbitrary seal, to test what unwrap rejects. */
function wrapSeal(seal: object, to: string): Event {
	const ephemeral = generateSecretKey();
	return finalizeEvent(
		{
			kind: GIFT_WRAP_KIND,
			created_at: NOW,
			tags: [["p", to]],
			content: nip44.encrypt(
				JSON.stringify(seal),
				nip44.getConversationKey(ephemeral, to),
			),
		},
		ephemeral,
	);
}

function sealRumor(rumor: object, signerSecret: Uint8Array, to: string): Event {
	return finalizeEvent(
		{
			kind: SEAL_KIND,
			created_at: NOW,
			tags: [],
			content: nip44.encrypt(
				JSON.stringify(rumor),
				nip44.getConversationKey(signerSecret, to),
			),
		},
		signerSecret,
	);
}

describe("unwrapRumor refuses what it cannot trust", () => {
	const rumor = createRumor({
		pubkey: SENDER,
		kind: MESSAGE_KIND,
		tags: [["p", RECIPIENT]],
		content: "{}",
		nowSec: NOW,
	});

	it("accepts the honest construction (control)", async () => {
		const event = wrapSeal(
			sealRumor(rumor, senderSecret, RECIPIENT),
			RECIPIENT,
		);
		expect(await unwrapRumor({ signer: recipient, event })).not.toBeNull();
	});

	it("REJECTS a rumor claiming an author other than the seal's signer — impersonation", async () => {
		// Mallory seals a rumor that says it is from SENDER. The seal's signature
		// is valid — it is just Mallory's — so only this check stops it.
		const mallory = generateSecretKey();
		const event = wrapSeal(sealRumor(rumor, mallory, RECIPIENT), RECIPIENT);
		expect(await unwrapRumor({ signer: recipient, event })).toBeNull();
	});

	it("REJECTS a rumor whose id does not hash its contents", async () => {
		const tampered = { ...rumor, content: '{"changed":true}' };
		const event = wrapSeal(
			sealRumor(tampered, senderSecret, RECIPIENT),
			RECIPIENT,
		);
		expect(await unwrapRumor({ signer: recipient, event })).toBeNull();
	});

	it("REJECTS a seal with a broken signature", async () => {
		const seal = sealRumor(rumor, senderSecret, RECIPIENT);
		const event = wrapSeal({ ...seal, sig: "0".repeat(128) }, RECIPIENT);
		expect(await unwrapRumor({ signer: recipient, event })).toBeNull();
	});

	it("REJECTS a rumor addressed to someone else, even re-wrapped to us", async () => {
		// A third party who received a rumor could otherwise forward it to us
		// under a valid seal of their own... except the seal must be the author's.
		// Here the AUTHOR re-addresses a rumor meant for OTHER to us: its `p`
		// does not name us, so it is not ours to act on.
		const other = getPublicKey(generateSecretKey());
		const elsewhere = createRumor({
			pubkey: SENDER,
			kind: MESSAGE_KIND,
			tags: [["p", other]],
			content: "{}",
			nowSec: NOW,
		});
		const event = wrapSeal(
			sealRumor(elsewhere, senderSecret, RECIPIENT),
			RECIPIENT,
		);
		expect(await unwrapRumor({ signer: recipient, event })).toBeNull();
	});

	it("returns null (never throws) on garbage", async () => {
		const ephemeral = generateSecretKey();
		const event = finalizeEvent(
			{
				kind: GIFT_WRAP_KIND,
				created_at: NOW,
				tags: [["p", RECIPIENT]],
				content: "not-nip44",
			},
			ephemeral,
		);
		expect(await unwrapRumor({ signer: recipient, event })).toBeNull();
		const notAWrap = { ...event, kind: RECEIPT_KIND };
		expect(
			await unwrapRumor({ signer: recipient, event: notAWrap }),
		).toBeNull();
	});
});

describe("NIP-40 expiration on the wrap", () => {
	it("gives every wrap the same expiration − created_at, whatever it carries", async () => {
		// That difference is public. If it differed by kind, it would say which
		// kind; if expiration came from the real clock, `expiration − ttl`
		// would be the true send time the backdate exists to hide.
		const { event: message } = await sendHello();
		const { event: receipt } = await signReceiptEvent({
			signer: recipient,
			recipientPubkey: SENDER,
			refEventId: "0".repeat(64),
			contextId: "ctx",
			status: "delivered",
			nowSec: NOW,
		});
		for (const event of [message, receipt]) {
			expect(eventExpiration(event)).toBe(
				event.created_at + WRAP_TTL_SEC,
			);
		}
	});

	it("puts nothing on the wrap that tracks the real send time", async () => {
		// Same real clock for every send: a tag derived from it would repeat.
		const expirations = new Set<number | null>();
		for (let i = 0; i < 6; i++) {
			const { event } = await sendHello();
			expirations.add(eventExpiration(event));
			for (const [name, value] of event.tags) {
				if (name !== "p") {
					expect(Number(value)).not.toBe(NOW + WRAP_TTL_SEC);
				}
			}
		}
		expect(expirations.size).toBeGreaterThan(1);
	});

	it("stays under the relay's expiration cap, and outlives the backdate", () => {
		expect(WRAP_TTL_SEC).toBeLessThanOrEqual(MAX_EXPIRATION_SEC);
		// A wrap backdated the full window still lives weeks of real time.
		expect(WRAP_TTL_SEC - MAX_WRAP_BACKDATE_SEC).toBeGreaterThan(
			7 * 24 * 60 * 60,
		);
	});

	it("reads no expiration from an event without the tag", () => {
		expect(
			eventExpiration({ tags: [["p", RECIPIENT]] } as unknown as Event),
		).toBeNull();
	});
});

describe("NIP-13 proof-of-work on the wrap", () => {
	it("mines every wrap to AGX_POW_BITS and commits to that target", async () => {
		const { event } = await sendHello();
		expect(getPow(event.id)).toBeGreaterThanOrEqual(AGX_POW_BITS);
		const nonce = tag(event, "nonce");
		expect(nonce?.[2]).toBe(String(AGX_POW_BITS));
	});

	it("mines without disturbing the backdated created_at", async () => {
		// nostr-tools' own minePow re-stamps created_at with "now", which would
		// silently undo NIP-59's timestamp obfuscation.
		const times = new Set<number>();
		for (let i = 0; i < 5; i++) {
			times.add((await sendHello()).event.created_at);
		}
		expect(times.size).toBeGreaterThan(1);
	});

	it("keeps the difficulty cheap enough to acknowledge a batch inside one ingest tick", () => {
		// Pinned as a NUMBER, not a wall-clock budget: a timing assertion flakes
		// under a loaded CI runner. Each bit doubles the expected work — 12 bits
		// is ~4k hashes (tens of ms per receipt in JS); 16 would be 16x that per
		// wrap, which an ingest tick acknowledging hundreds of messages would
		// feel. Raising it is a protocol change (the relay enforces the same
		// floor, pinned in relay-config.test.ts), so it should fail here first.
		expect(AGX_POW_BITS).toBe(12);
	});
});

describe("NIP-13 miner guards the bytes it hashes", () => {
	const template = (tags: string[][]) => ({
		kind: GIFT_WRAP_KIND,
		created_at: NOW,
		tags,
		content: "Y29udGVudA==",
	});
	const PUBKEY = getPublicKey(generateSecretKey());

	it("mines a nonce that holds on the event as serialized (control)", async () => {
		const { __mineWrapForTests } = await import("./giftwrap");
		const mined = __mineWrapForTests(
			template([["p", RECIPIENT]]),
			PUBKEY,
			8,
		);
		const id = getEventHash(mined);
		expect(getPow(id)).toBeGreaterThanOrEqual(8);
	});

	it("throws rather than return a nonce mined against the wrong bytes", async () => {
		// A tag ahead of the nonce carrying the placeholder text would make the
		// prefix/suffix split land in the wrong place. Before the guard this
		// returned an event whose real id missed the target — and every relay
		// would have refused it with a PoW error far from the cause.
		const { __mineWrapForTests } = await import("./giftwrap");
		expect(() =>
			__mineWrapForTests(template([["x", "__AGX_NONCE__"]]), PUBKEY, 12),
		).toThrow(/NIP-13/);
	});
});

describe("the NIP-59 backdate comes from a CSPRNG", () => {
	it("does not depend on Math.random", async () => {
		// With Math.random pinned, a Math.random-derived offset would be the
		// same for every wrap. The offsets must still vary — and stay in bounds.
		const spy = vi.spyOn(Math, "random").mockReturnValue(0.5);
		try {
			const times = new Set<number>();
			for (let i = 0; i < 6; i++) {
				const { event } = await sendHello();
				expect(event.created_at).toBeLessThanOrEqual(NOW);
				expect(event.created_at).toBeGreaterThan(
					NOW - MAX_WRAP_BACKDATE_SEC,
				);
				times.add(event.created_at);
			}
			expect(times.size).toBeGreaterThan(1);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
});
