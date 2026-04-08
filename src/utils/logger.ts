export type LogLevel = "debug" | "info" | "warn" | "error";

type LogContext = Record<string, unknown>;

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

let minLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
	minLevel = level;
}

function shouldLog(level: LogLevel): boolean {
	return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function formatEntry(
	level: LogLevel,
	message: string,
	context?: LogContext,
): string {
	const entry = {
		timestamp: new Date().toISOString(),
		level,
		message,
		...context,
	};
	return JSON.stringify(entry);
}

function log(level: LogLevel, message: string, context?: LogContext): void {
	if (!shouldLog(level)) return;
	const line = formatEntry(level, message, context);
	if (level === "error") {
		process.stderr.write(line + "\n");
	} else {
		process.stdout.write(line + "\n");
	}
}

export const logger = {
	debug: (message: string, context?: LogContext) =>
		log("debug", message, context),
	info: (message: string, context?: LogContext) =>
		log("info", message, context),
	warn: (message: string, context?: LogContext) =>
		log("warn", message, context),
	error: (message: string, context?: LogContext) =>
		log("error", message, context),
};
