import {
	assertSettableKey,
	coerceSettableValue,
	effectiveProfile,
	getProfile,
	loadConfig,
	resolveProfileName,
	saveConfig,
	updateProfile,
} from "../lib/config.js";
import { usageError } from "../lib/errors.js";
import { heading, info, json, kv, ok, say } from "../lib/output.js";
import { configPath } from "../lib/paths.js";

export interface ConfigOptions {
	profile?: string;
	reveal?: boolean;
}

function mask(value: string | null, reveal: boolean): string | null {
	if (!value) {
		return null;
	}
	return reveal ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

export function configShowCommand(options: ConfigOptions): void {
	const profileName = resolveProfileName(options.profile);
	const profile = effectiveProfile(profileName);
	heading(`profile "${profileName}"`);
	kv("apiBaseUrl", profile.apiBaseUrl);
	kv("apiKey", mask(profile.apiKey, options.reveal ?? false));
	kv("orgSlug", profile.orgSlug);
	kv("relays", profile.relays.join(", "));
	kv("org", profile.org);
	kv("nip05", profile.nip05);
	kv("allow", `${profile.allow.length} peer(s)`);
	kv("file", configPath());
	json({
		profile: profileName,
		...profile,
		apiKey: mask(profile.apiKey, options.reveal ?? false),
	});
}

export function configSetCommand(
	key: string,
	value: string,
	options: ConfigOptions,
): void {
	const profileName = resolveProfileName(options.profile);
	const settable = assertSettableKey(key);
	updateProfile(profileName, coerceSettableValue(settable, value));
	ok(`Set ${settable} on profile "${profileName}".`);
}

export function configUseCommand(profileName: string): void {
	const config = loadConfig();
	if (!config.profiles[profileName]) {
		// Creating on switch is deliberate: a new profile is the supported way to
		// hold a second identity or a second organization's key.
		config.profiles[profileName] = getProfile(profileName);
		info(`Created profile "${profileName}".`);
	}
	config.currentProfile = profileName;
	saveConfig(config);
	ok(`Active profile is now "${profileName}".`);
}

export function configListCommand(): void {
	const config = loadConfig();
	const names = Object.keys(config.profiles);
	heading("profiles");
	if (names.length === 0) {
		say("  (none yet — `agx config set orgSlug acme` creates one)");
	}
	for (const name of names) {
		const marker = name === config.currentProfile ? "*" : " ";
		const profile = config.profiles[name];
		say(`${marker} ${name.padEnd(16)} ${profile?.orgSlug ?? "—"}`);
	}
	json({ current: config.currentProfile, profiles: names });
}

export function configPathCommand(): void {
	console.log(configPath());
}

export function assertConfigSubcommand(sub: string): void {
	const known = ["show", "set", "use", "list", "path"];
	if (!known.includes(sub)) {
		throw usageError(
			`Unknown config subcommand "${sub}".`,
			`Try one of: ${known.join(", ")}`,
		);
	}
}
