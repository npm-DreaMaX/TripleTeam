#!/usr/bin/env node

import { LocalControlDaemon } from "./server.ts";

function parseArguments(args: string[]): { repository: string; port: number } {
	let repository = process.cwd();
	let port = 0;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--port") {
			const value = args[++index];
			if (!value || !/^\d+$/.test(value)) throw new Error("--port requires an integer");
			port = Number(value);
			if (port < 0 || port > 65_535) throw new Error("port is outside the valid range");
		} else if (argument) {
			repository = argument;
		}
	}
	return { repository, port };
}

async function main(): Promise<void> {
	const options = parseArguments(process.argv.slice(2));
	const daemon = await LocalControlDaemon.create(options.repository);
	const endpoint = await daemon.start(options.port);
	console.log(JSON.stringify({ ...endpoint, token: "stored in " + daemon.endpointFilePath }, null, 2));
	let stopping = false;
	const stop = (): void => {
		if (stopping) return;
		stopping = true;
		void daemon.stop().then(
			() => process.exit(0),
			(error) => {
				console.error(error instanceof Error ? error.message : String(error));
				process.exit(1);
			},
		);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
