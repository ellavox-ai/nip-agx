import { createApiClient, toCliError } from "../lib/api.js";
import {
	effectiveProfile,
	requireApiCredentials,
	resolveProfileName,
} from "../lib/config.js";
import { usageError } from "../lib/errors.js";
import {
	heading,
	info,
	json,
	kv,
	ok,
	say,
	table,
	warn,
} from "../lib/output.js";

export interface DomainOptions {
	profile?: string;
	org?: string;
	yes?: boolean;
}

interface SerializedDomain {
	id: string;
	domain: string;
	method: string;
	status: string;
	verified: boolean;
	verifiedAt: string | null;
	lastCheckedAt: string | null;
	consecutiveFailures: number;
	lastFailureReason: string | null;
}

function ctx(options: DomainOptions) {
	const profileName = resolveProfileName(options.profile);
	const profile = effectiveProfile(profileName);
	const creds = requireApiCredentials(
		options.org ? { ...profile, orgSlug: options.org } : profile,
		profileName,
	);
	return { creds, client: createApiClient(creds) };
}

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/i;

export async function domainAddCommand(
	domain: string,
	options: DomainOptions,
): Promise<void> {
	const { creds, client } = ctx(options);
	if (LOCAL_HOST_RE.test(domain)) {
		warn(
			"A localhost domain can never be verified. NIP-05 verification fetches https://<domain>/.well-known/nostr.json through an SSRF guard that blocks loopback and private addresses, deliberately with no bypass.",
		);
		say(
			"  Expose the index over public HTTPS instead:  cloudflared tunnel --url http://localhost:3000",
		);
	}
	let result: SerializedDomain;
	try {
		result = await client.agentIndex.createDomain({
			orgSlug: creds.orgSlug,
			domain,
		});
	} catch (error) {
		throw toCliError(error, "createDomain", creds.baseUrl);
	}
	ok(`Claimed ${result.domain}`);
	kv("id", result.id);
	kv("status", result.status);
	say("");
	info(
		`Claim a handle on it, then verify:\n    agx register --slug <slug> --handle bot --domain-id ${result.id}\n    agx domain verify ${result.id}`,
	);
	json(result);
}

export async function domainListCommand(options: DomainOptions): Promise<void> {
	const { creds, client } = ctx(options);
	let result: { domains: SerializedDomain[] };
	try {
		result = await client.agentIndex.listDomains({
			orgSlug: creds.orgSlug,
		});
	} catch (error) {
		throw toCliError(error, "listDomains", creds.baseUrl);
	}
	heading(`domains claimed by "${creds.orgSlug}"`);
	table(
		result.domains.map((d) => [
			d.id,
			d.domain,
			d.status,
			d.verified ? "yes" : "—",
			d.lastFailureReason ?? "",
		]),
		["ID", "DOMAIN", "STATUS", "VERIFIED", "LAST FAILURE"],
	);
	json(result);
}

export async function domainVerifyCommand(
	domainId: string,
	options: DomainOptions,
): Promise<void> {
	const { creds, client } = ctx(options);
	let result: {
		domain: SerializedDomain;
		results: Array<{
			listingId: string;
			handle: string;
			ok: boolean;
			reason?: string;
		}>;
		checkedCount: number;
		totalCandidates: number;
	};
	try {
		result = await client.agentIndex.verifyDomain({
			orgSlug: creds.orgSlug,
			domainId,
		});
	} catch (error) {
		throw toCliError(error, "verifyDomain", creds.baseUrl);
	}

	heading(`verification of ${result.domain.domain}`);
	kv("status", result.domain.status);
	kv("verified", result.domain.verified ? "yes" : "no");
	kv("checked", `${result.checkedCount} of ${result.totalCandidates}`);
	table(
		result.results.map((r) => [
			r.handle,
			r.ok ? "pass" : "fail",
			r.reason ?? "",
		]),
		["HANDLE", "RESULT", "REASON"],
	);

	if (!result.domain.verified) {
		say("");
		info(
			"Verification fetches https://<domain>/.well-known/nostr.json?name=<handle> and requires it to map back to the listing's pubkey. It must be reachable over PUBLIC HTTPS — the SSRF guard blocks localhost and private addresses with no environment bypass, and the platform's own domain cannot be claimed because serving the claimant's own key would make verification circular.",
		);
		say(
			"  For a local run, expose your local index:  cloudflared tunnel --url http://localhost:3000",
		);
	}
	json(result);
}

export async function domainRemoveCommand(
	domainId: string,
	options: DomainOptions,
): Promise<void> {
	const { creds, client } = ctx(options);
	if (!options.yes) {
		throw usageError(
			"Removing a domain clears the handle and verification badge from every listing on it.",
			`Confirm with:  agx domain remove ${domainId} --yes`,
		);
	}
	try {
		await client.agentIndex.deleteDomain({
			orgSlug: creds.orgSlug,
			domainId,
		});
	} catch (error) {
		throw toCliError(error, "deleteDomain", creds.baseUrl);
	}
	ok("Domain removed; handles and badges on it were cleared.");
	json({ ok: true });
}
