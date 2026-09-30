import { existsSync, readFileSync } from "node:fs";
import {
	type AgxSigner,
	bytesToHex,
	generateKeypair,
	hexToBytes,
	localSigner,
	publicKeyFromSecret,
	toNpub,
} from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { z } from "zod";
import { AgxCliError, configError, EXIT, usageError } from "./errors.js";
import { identityPath, isTooPermissive, writePrivateJson } from "./paths.js";

/**
 * The agent's secp256k1 identity. Stored as hex — that is the form every call
 * site wants, and it keeps the file diffable; `agx identity export --nsec`
 * produces the portable NIP-19 form on demand. `@nostr-agx/core`/`@nostr-agx/nostr`
 * deliberately expose no nsec codec, so `nostr-tools`' `nip19` is used directly.
 */

const identityFileSchema = z.object({
	version: z.literal(1),
	secretKeyHex: z.string().length(64),
	publicKey: z.string().length(64),
	npub: z.string(),
	createdAt: z.string(),
	source: z.enum(["generated", "imported"]),
});

export type IdentityFile = z.infer<typeof identityFileSchema>;

export interface Identity {
	/** Everything that signs or decrypts goes through this; the raw key stays in
	 * the identity file and is only read back out by `agx identity export`. */
	signer: AgxSigner;
	publicKey: string;
	npub: string;
}

export function createIdentity(
	source: "generated" | "imported" = "generated",
): IdentityFile {
	const { secretKey, publicKey } = generateKeypair();
	return {
		version: 1,
		secretKeyHex: bytesToHex(secretKey),
		publicKey,
		npub: toNpub(publicKey),
		createdAt: new Date().toISOString(),
		source,
	};
}

export function identityFromSecret(
	secretKey: Uint8Array,
	source: "generated" | "imported",
): IdentityFile {
	const publicKey = publicKeyFromSecret(secretKey);
	return {
		version: 1,
		secretKeyHex: bytesToHex(secretKey),
		publicKey,
		npub: toNpub(publicKey),
		createdAt: new Date().toISOString(),
		source,
	};
}

/** Accept either an `nsec1…` or a bare 64-char hex secret. */
export function parseSecretInput(input: string): Uint8Array {
	const trimmed = input.trim();
	if (trimmed.startsWith("nsec1")) {
		try {
			const decoded = nip19.decode(trimmed);
			if (decoded.type !== "nsec") {
				throw new Error(`expected an nsec, got ${decoded.type}`);
			}
			return decoded.data as Uint8Array;
		} catch (error) {
			throw usageError(
				`Could not decode that nsec: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	if (/^[0-9a-f]{64}$/i.test(trimmed)) {
		return hexToBytes(trimmed.toLowerCase());
	}
	throw usageError(
		"Expected an `nsec1…` key or a 64-character hex secret key.",
	);
}

export function toNsec(secretKey: Uint8Array): string {
	return nip19.nsecEncode(secretKey);
}

export function saveIdentity(profile: string, identity: IdentityFile): void {
	writePrivateJson(identityPath(profile), identity);
}

export function identityExists(profile: string): boolean {
	return existsSync(identityPath(profile));
}

export function loadIdentityFile(
	profile: string,
	options?: { allowInsecurePerms?: boolean },
): IdentityFile {
	const path = identityPath(profile);
	if (!existsSync(path)) {
		throw configError(
			`Profile "${profile}" has no identity.`,
			"agx identity new",
		);
	}
	if (!options?.allowInsecurePerms && isTooPermissive(path)) {
		throw new AgxCliError(
			`${path} is readable by other users and holds your secret key.`,
			{
				exitCode: EXIT.config,
				remediation: `chmod 600 ${path}\n  (or run: agx doctor --fix-perms)`,
			},
		);
	}
	const parsed = identityFileSchema.safeParse(
		JSON.parse(readFileSync(path, "utf8")),
	);
	if (!parsed.success) {
		throw configError(
			`${path} is not a valid agx identity file.`,
			`Back it up and regenerate: mv ${path} ${path}.bak && agx identity new`,
		);
	}
	return parsed.data;
}

export function loadIdentity(
	profile: string,
	options?: { allowInsecurePerms?: boolean },
): Identity {
	const file = loadIdentityFile(profile, options);
	return {
		signer: localSigner(hexToBytes(file.secretKeyHex)),
		publicKey: file.publicKey,
		npub: file.npub,
	};
}
