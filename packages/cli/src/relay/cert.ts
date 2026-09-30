import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgxCliError, EXIT } from "../lib/errors.js";
import { agxHome, ensureDir, writePrivateJson } from "../lib/paths.js";

/**
 * A self-signed certificate for the local relay's `wss://` listener.
 *
 * Why this exists: a host that stores relay URLs as `wss://` dials them for real.
 * A CLI can sidestep that by using `ws://` directly, but anything running inside
 * the application server cannot — it has no downgrade shim — so publishing an
 * Agent Card or a human-authored reply silently fails against a plain-ws relay.
 * Terminating TLS locally is what makes those paths exercisable.
 *
 * Generated with `openssl` rather than a JS X.509 library to keep the dependency
 * surface at zero. The SAN goes in a temp CONFIG FILE, not `-addext`: macOS ships
 * LibreSSL, whose `openssl req` does not support that flag, and a cert without
 * `subjectAltName` is rejected by Node's TLS verifier regardless of its CN.
 */

export interface RelayCert {
	certPath: string;
	keyPath: string;
	cert: string;
	key: string;
	/** True when this call created the files rather than reusing them. */
	created: boolean;
}

const CONFIG = `[req]
distinguished_name = dn
x509_extensions = ext
prompt = no

[dn]
CN = localhost
O = agx local relay

[ext]
basicConstraints = critical,CA:TRUE
subjectAltName = @alt

[alt]
DNS.1 = localhost
IP.1 = 127.0.0.1
IP.2 = ::1
`;

function certDir(): string {
	return join(agxHome(), "relay");
}

export function relayMetaPath(): string {
	return join(certDir(), "meta.json");
}

/**
 * What a running relay is serving, written on start and read by anything that
 * has to dial it.
 *
 * A client needs this to know which of the two loopback ports is TLS: it can
 * downgrade `wss://localhost` to plain `ws` for the ordinary port, but the TLS
 * port must be dialed as real TLS with this certificate as the trust anchor.
 * Guessing wrong produces a protocol mismatch that looks like the relay is down.
 */
export interface RelayMeta {
	version: 1;
	plainPort: number;
	tlsPort: number | null;
	certPath: string | null;
	startedAt: string;
}

export function writeRelayMeta(meta: Omit<RelayMeta, "version">): void {
	ensureDir(certDir());
	writePrivateJson(relayMetaPath(), { version: 1, ...meta });
}

/**
 * Load the local relay certificate, generating it on first use.
 *
 * Self-signed with `CA:TRUE` deliberately: a client trusts it by being
 * pointed at the same file through `NODE_EXTRA_CA_CERTS`, which expects a trust
 * anchor. Scoped to localhost SANs, so it cannot authenticate any real host.
 */
export function ensureRelayCert(options?: { force?: boolean }): RelayCert {
	const dir = certDir();
	const certPath = join(dir, "relay-cert.pem");
	const keyPath = join(dir, "relay-key.pem");

	if (!options?.force && existsSync(certPath) && existsSync(keyPath)) {
		return {
			certPath,
			keyPath,
			cert: readFileSync(certPath, "utf8"),
			key: readFileSync(keyPath, "utf8"),
			created: false,
		};
	}

	ensureDir(dir);
	const tmp = mkdtempSync(join(tmpdir(), "agx-cert-"));
	const configPath = join(tmp, "openssl.cnf");
	writeFileSync(configPath, CONFIG);

	try {
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-days",
				"825",
				"-keyout",
				keyPath,
				"-out",
				certPath,
				"-config",
				configPath,
			],
			{ stdio: "pipe" },
		);
	} catch (error) {
		const detail =
			error instanceof Error && "stderr" in error
				? String((error as { stderr?: Buffer }).stderr ?? error.message)
				: String(error);
		throw new AgxCliError(
			`Could not generate a TLS certificate with openssl: ${detail.trim().split("\n").pop() ?? detail}`,
			{
				exitCode: EXIT.generic,
				remediation:
					"`agx relay --tls` shells out to openssl, which ships with macOS and most Linux distributions.\n  Without it, run the relay in plain mode (`agx relay`) — only clients that dial wss:// for real, with no localhost downgrade, need TLS.",
			},
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}

	return {
		certPath,
		keyPath,
		cert: readFileSync(certPath, "utf8"),
		key: readFileSync(keyPath, "utf8"),
		created: true,
	};
}
