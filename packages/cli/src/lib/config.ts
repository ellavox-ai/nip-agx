import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { configError, usageError } from "./errors.js";
import { configPath, writePrivateJson } from "./paths.js";

/**
 * Profile store. A profile is one (identity, API credential, organization,
 * relay set, peer allowlist) tuple — so "the same agent seen by another org" and
 * "a second agent on the same relay" are both just a second profile, which is
 * what makes the cross-org discovery step of the walkthrough runnable at all.
 */

export const profileSchema = z.object({
	apiBaseUrl: z.string().default("http://localhost:3000"),
	apiKey: z.string().nullable().default(null),
	orgSlug: z.string().nullable().default(null),
	relays: z.array(z.string()).default(["ws://127.0.0.1:7447"]),
	/** Display label advertised on the Agent Card. */
	org: z.string().nullable().default(null),
	nip05: z.string().nullable().default(null),
	/** Hex pubkeys this agent will accept task requests from. Default-deny: an
	 * empty list means nobody, which is the SPEC's required posture. */
	allow: z.array(z.string()).default([]),
});

export type Profile = z.infer<typeof profileSchema>;

export const configSchema = z.object({
	version: z.literal(1).default(1),
	currentProfile: z.string().default("default"),
	profiles: z.record(z.string(), profileSchema).default({}),
});

export type AgxConfig = z.infer<typeof configSchema>;

const EMPTY_PROFILE: Profile = profileSchema.parse({});

export function loadConfig(): AgxConfig {
	const path = configPath();
	if (!existsSync(path)) {
		return configSchema.parse({});
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw configError(
			`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			`Fix or delete the file, then re-run: rm ${path}`,
		);
	}
	const parsed = configSchema.safeParse(raw);
	if (!parsed.success) {
		throw configError(
			`${path} does not match the expected shape.`,
			`Fix or delete the file, then re-run: rm ${path}`,
		);
	}
	return parsed.data;
}

export function saveConfig(config: AgxConfig): void {
	writePrivateJson(configPath(), config);
}

/** Resolve the active profile name: flag, then env, then the stored default. */
export function resolveProfileName(flag?: string): string {
	return flag ?? process.env.AGX_PROFILE ?? loadConfig().currentProfile;
}

export function getProfile(name: string): Profile {
	const config = loadConfig();
	return config.profiles[name] ?? { ...EMPTY_PROFILE };
}

export function saveProfile(name: string, profile: Profile): void {
	const config = loadConfig();
	config.profiles[name] = profile;
	if (!config.profiles[config.currentProfile]) {
		config.currentProfile = name;
	}
	saveConfig(config);
}

export function updateProfile(name: string, patch: Partial<Profile>): Profile {
	const next = { ...getProfile(name), ...patch };
	saveProfile(name, next);
	return next;
}

/** Environment overrides are applied per-read rather than persisted, so a
 * one-off `AGX_API_KEY=… agx search` never mutates the stored profile. */
export function effectiveProfile(name: string): Profile {
	const stored = getProfile(name);
	return {
		...stored,
		apiBaseUrl: process.env.AGX_API_URL ?? stored.apiBaseUrl,
		apiKey: process.env.AGX_API_KEY ?? stored.apiKey,
		orgSlug: process.env.AGX_ORG ?? stored.orgSlug,
		relays: process.env.AGX_RELAY
			? process.env.AGX_RELAY.split(",").map((r) => r.trim())
			: stored.relays,
	};
}

export interface ApiCredentials {
	baseUrl: string;
	apiKey: string;
	orgSlug: string;
}

/** Assert the three things every Agent Index call needs, with the exact command
 * to fix whichever one is missing. */
export function requireApiCredentials(
	profile: Profile,
	profileName: string,
): ApiCredentials {
	if (!profile.apiKey) {
		throw configError(
			`Profile "${profileName}" has no API key.`,
			"Mint a key scoped to your organization in the index you are talking to, then:\n    agx config set apiKey <key>",
		);
	}
	if (!profile.orgSlug) {
		throw configError(
			`Profile "${profileName}" has no organization slug.`,
			"agx config set orgSlug acme",
		);
	}
	return {
		baseUrl: profile.apiBaseUrl.replace(/\/$/, ""),
		apiKey: profile.apiKey,
		orgSlug: profile.orgSlug,
	};
}

const SETTABLE = [
	"apiBaseUrl",
	"apiKey",
	"orgSlug",
	"relays",
	"org",
	"nip05",
] as const;

export type SettableKey = (typeof SETTABLE)[number];

export function assertSettableKey(key: string): SettableKey {
	if (!(SETTABLE as readonly string[]).includes(key)) {
		throw usageError(
			`Unknown config key "${key}".`,
			`Settable keys: ${SETTABLE.join(", ")}`,
		);
	}
	return key as SettableKey;
}

export function coerceSettableValue(
	key: SettableKey,
	value: string,
): Partial<Profile> {
	if (key === "relays") {
		return {
			relays: value
				.split(",")
				.map((r) => r.trim())
				.filter(Boolean),
		};
	}
	return { [key]: value } as Partial<Profile>;
}
