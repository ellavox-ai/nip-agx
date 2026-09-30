import { parseTaskEnvelope, TASK_CONTENT_TYPE } from "@nostr-agx/core";

/**
 * Which typed capabilities `agx serve` answers. Pure, so the one decision that
 * makes a watch sign and publish results on its own can be tested on its own.
 *
 * `--no-tasks` registers NO handler — not the built-in `invoice.review`
 * stand-in, not `agx.ping`. With nothing registered, `@nostr-agx/core` consumes no
 * task request: every one falls through to `onMessage` and prints like any
 * other message (RECV, or HOLD under `--allowed-only`), and no receipt or
 * result is ever published.
 */

/** Always served when tasks are on: a liveness probe a peer can call. */
export const PING_CAPABILITY = "agx.ping";

/** The canned stand-in served when neither `--capability` nor `--handler` names one. */
export const DEFAULT_CAPABILITY = "invoice.review";

export interface ServeTaskFlags {
	/** `false` under `--no-tasks` (commander's negated-option default is `true`). */
	tasks?: boolean;
	capability?: string[];
	handler?: string;
	advertise?: boolean;
	allowAll?: boolean;
}

/**
 * The flags `--no-tasks` contradicts, with why. Each of them only means
 * something when capabilities are served, so combining them is a usage error
 * rather than a silent no-op:
 *
 *   - `--capability` / `--handler` name capabilities to serve.
 *   - `--advertise` publishes an Agent Card listing served capabilities; with
 *     none, the card would announce an agent that answers no typed request.
 *   - `--allow-all` opens task requests to every peer.
 */
export function noTasksConflicts(flags: ServeTaskFlags): string[] {
	if (flags.tasks !== false) {
		return [];
	}
	const conflicts: string[] = [];
	if (flags.capability?.length) {
		conflicts.push("--capability (names a capability to serve)");
	}
	if (flags.handler) {
		conflicts.push("--handler (binds capabilities to serve)");
	}
	if (flags.advertise) {
		conflicts.push(
			"--advertise (publishes an Agent Card of served capabilities, and there are none)",
		);
	}
	if (flags.allowAll) {
		conflicts.push("--allow-all (opens task requests to every peer)");
	}
	return conflicts;
}

/**
 * The capabilities to register handlers for, excluding `agx.ping` (see
 * {@link servesPing}). Empty under `--no-tasks`.
 */
export function capabilitiesToServe(
	flags: ServeTaskFlags,
	handlerKeys: string[],
): string[] {
	if (flags.tasks === false) {
		return [];
	}
	if (flags.capability?.length) {
		return flags.capability;
	}
	return handlerKeys.length > 0 ? handlerKeys : [DEFAULT_CAPABILITY];
}

export function servesPing(flags: ServeTaskFlags): boolean {
	return flags.tasks !== false;
}

/** Printed under a task request that `--no-tasks` left unanswered. */
export const UNANSWERED_TASK_REQUEST_NOTE =
	"(typed task request — --no-tasks: not answered)";
/** Printed under any other task-labelled message: a late or stray result, or an
 * envelope that does not parse. Nothing would have answered it anyway. */
export const UNHANDLED_TASK_MESSAGE_NOTE =
	"(typed task message — --no-tasks: not handled)";

export interface TaskLabelledMessage {
	contentType: string;
	text: string;
}

/**
 * The note `serve --no-tasks` prints under a message that reached `onMessage`
 * carrying the task content type, or `null` when none applies. `contentType`
 * and the envelope are both peer-supplied, so this only labels what was
 * printed; it decides nothing.
 */
export function unservedTaskNote(
	flags: Pick<ServeTaskFlags, "tasks">,
	message: TaskLabelledMessage,
): string | null {
	if (flags.tasks !== false || message.contentType !== TASK_CONTENT_TYPE) {
		return null;
	}
	return parseTaskEnvelope(message.text)?.t === "req"
		? UNANSWERED_TASK_REQUEST_NOTE
		: UNHANDLED_TASK_MESSAGE_NOTE;
}
