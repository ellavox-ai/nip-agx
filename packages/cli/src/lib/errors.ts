/**
 * Every failure the CLI reports carries a remediation. A tool whose job is to
 * exercise a multi-process system fails for boring environmental reasons far more
 * often than for interesting ones, so "what do I type next" is part of the error,
 * not an afterthought.
 */

export const EXIT = {
	ok: 0,
	generic: 1,
	usage: 2,
	/** No profile, no identity, missing local config. */
	config: 3,
	/** API rejected the credential, or it is bound to another organization. */
	auth: 4,
	/** Index or relay unreachable. */
	network: 5,
	/** The remote refused the request on its merits (403/422). */
	remote: 6,
	interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class AgxCliError extends Error {
	readonly exitCode: ExitCode;
	readonly remediation: string | null;

	constructor(
		message: string,
		options?: { exitCode?: ExitCode; remediation?: string | null },
	) {
		super(message);
		this.name = "AgxCliError";
		this.exitCode = options?.exitCode ?? EXIT.generic;
		this.remediation = options?.remediation ?? null;
	}
}

export function configError(message: string, remediation: string): AgxCliError {
	return new AgxCliError(message, { exitCode: EXIT.config, remediation });
}

export function usageError(message: string, remediation?: string): AgxCliError {
	return new AgxCliError(message, {
		exitCode: EXIT.usage,
		remediation: remediation ?? null,
	});
}

export function networkError(
	message: string,
	remediation: string,
): AgxCliError {
	return new AgxCliError(message, { exitCode: EXIT.network, remediation });
}
