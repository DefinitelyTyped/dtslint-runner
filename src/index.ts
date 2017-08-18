import assert = require("assert");
import { exec } from "child_process";
import { pathExists, readdir } from "fs-extra";
import { join as joinPaths } from "path";

const pathToDtsLint = require.resolve("dtslint");

if (module.parent === null) { // tslint:disable-line no-null-keyword
	let onlyLint = false;
	let nProcesses = 8; // tslint:disable-line no-magic-numbers
	const { argv } = process;
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--onlyLint": {
				onlyLint = true;
				break;
			}
			case "--nProcesses": {
				i++;
				assert(i < argv.length);
				nProcesses = Number.parseInt(argv[i]);
				assert(!Number.isNaN(nProcesses));
				break;
			}
			default:
				throw new Error(`Unexpected arg ${arg}`);
		}
	}

	main(nProcesses, onlyLint)
		.then(code => {
			if (code !== 0) {
				console.error("FAILED");
			}
			process.exit(code);
		})
		.catch(err => { console.error(err); });
}

async function main(nProcesses: number, onlyLint: boolean): Promise<number> {
	/*const installError = await run(/*cwd* / undefined, pathToDtsLint, "--installAll");
	if (installError !== undefined) {
		return 1;
	}*/

	const dtDir = joinPaths(process.cwd(), "..", "DefinitelyTyped");
	if (!(await pathExists(dtDir))) {
		throw new Error("Should be run in a directory next to DefinitelyTyped");
	}

	const allPackages = await getAllPackages(dtDir);

	const packageToErrors = await nAtATime(nProcesses, allPackages, async ({ name, path }) => {
		console.log(name);
		return { name, error: await testPackage(path, onlyLint) };
	});
	const errors = packageToErrors.filter(({ error }) => error !== undefined) as
		Array<{ name: string, error: string }>;

	if (errors.length === 0) {
		console.log("No errors");
		return 0;
	}

	for (const { name, error } of errors) {
		console.error(name);
		console.error(`  ${error.replace(/\n/g, "\n  ")}`);
	}

	console.error(`Failing packages: ${errors.map(e => e.name).join(", ")}`);
	return 1;
}

const exclude = new Set<string>([
	"webrtc",
	"webspeechapi",
	"whatwg-streams",
	"tinymce",
	"transducers-js",
	"skyway",
	"react-router/v3",
	"react-dom",
	"react/v15",
	"q/v0",
	"pngjs2",
	"peerjs",
	"oibackoff",
	"leaflet-draw",
	"kendo-ui",
	"i18next/v2",

	// https://github.com/Microsoft/dtslint/pull/61
	"jquery",

	// https://github.com/reactjs/redux/pull/2530
	"redux-form",
	"redux-first-router",
	"redux-mock-store",
	"redux-pack",

	"fs-extra",
	"koa-generic-session",
	"bluebird",
	"xadesjs",
	"bufferstream",
	"split",
	"n3",

	// Have PRs, waiting for merge
	"angular",
	"gulp",
	"i18next",
	"pad",
	"jasminewd2",
	"webcomponents.js",
	"webpack",
	"redux-batched-subscribe",
	"redux-actions",
	"redux-action",
	"react-native-goby",
	"react-app",
	"ramda",
	"baidumap-web-sdk",
	"selenium-webdriver",
	"react-virtualized-select",
	"sencha_touch",
	"mithril",
	"ej.web.all",
]);

async function getAllPackages(dtDir: string): Promise<Array<{ name: string, path: string }>> {
	const typesDir = joinPaths(dtDir, "types");
	const packageNames = await readdir(typesDir);
	const results = await nAtATime(1, packageNames, async packageName => {
		const packageDir = joinPaths(typesDir, packageName);
		const files = await readdir(packageDir);
		const packages = [{ name: packageName, path: packageDir }];
		for (const file of files) {
			if (/^v\d+$/.test(file)) {
				const name = `${packageName}/${file}`;
				if (!exclude.has(name)) {
					packages.push({ name, path: joinPaths(packageDir, file) });
				}
			}
		}
		return packages;
	});
	return ([] as Array<{ name: string, path: string }>).concat(...results);
}

async function testPackage(packagePath: string, onlyLint: boolean): Promise<string | undefined> {
	const shouldLint = await pathExists(joinPaths(packagePath, "tslint.json"));
	if (onlyLint && !shouldLint) {
		return undefined;
	}
	const args = shouldLint ? [] : ["--noLint"];
	return await run(packagePath, pathToDtsLint, ...args);
}

function run(cwd: string | undefined, cmd: string, ...args: string[]): Promise<string | undefined> {
	const nodeCmd = `node ${cmd} ${args.join(" ")}`;
	return new Promise<string | undefined>(resolve => {
		exec(nodeCmd, { encoding: "utf8", cwd }, (error, stdout, stderr) => {
			stdout = stdout.trim();
			stderr = stderr.trim();
			if (stdout !== "") {
				console.log(stdout);
			}
			if (stderr !== "") {
				console.error(stderr);
			}
			// tslint:disable-next-line no-null-keyword strict-type-predicates
			if (error === null) {
				if (stderr !== "") {
					resolve(`${stdout}\n${stderr}`);
				} else {
					resolve(undefined);
				}
			} else {
				resolve(`${error.message}\n${stdout}\n${stderr}`);
			}
		});
	});
}

async function nAtATime<T, U>(n: number, inputs: ReadonlyArray<T>, use: (t: T) => Promise<U>): Promise<U[]> {
	const results = new Array(inputs.length);
	let nextIndex = 0;
	await Promise.all(initArray(n, async () => {
		while (nextIndex !== inputs.length) {
			const index = nextIndex;
			nextIndex++;
			const output = await use(inputs[index]);
			results[index] = output;
		}
	}));
	return results;
}

function initArray<T>(length: number, makeElement: () => T): T[] {
	const arr = new Array(length);
	for (let i = 0; i < length; i++) {
		arr[i] = makeElement();
	}
	return arr;
}
