import assert = require("assert");
import { ChildProcess, exec, fork } from "child_process";
import { pathExists, readdir, remove } from "fs-extra";
import { cpus } from "os";
import { join as joinPaths } from "path";

const pathToDtsLint = require.resolve("dtslint");

if (module.parent === null) { // tslint:disable-line no-null-keyword
    let clone = false;
    let cloneSha: string | undefined = undefined;
    let noInstall = false;
    let tsLocal: string | undefined;
    let onlyTestTsNext = false;
    let expectOnly = false;
    let nProcesses = cpus().length;
    let shardId: number | undefined = undefined;
    let shardCount: number | undefined = undefined;
    const { argv } = process;
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case "--onlyTestTsNext":
                onlyTestTsNext = true;
                break;
            case "--localTs":
                if (i + 1 >= argv.length) {
                    throw new Error("Path for --localTs was not provided.");
                }
                else if (argv[i + 1].startsWith("--")) {
                    throw new Error("Looking for local path for TS, but got " + tsLocal);
                }
                else {
                    tsLocal = argv[i + 1];
                    i++;
                }
                break;
            case "--expectOnly":
                expectOnly = true;
                break;
            case "--clone":
                clone = true;
                if ((i + 1) < argv.length && argv[i + 1].indexOf("-") !== 0) {
                    // Next argument is a specific DT SHA to clone if it doesn't start with a `-`
                    i++;
                    cloneSha = argv[i];
                }
                break;
            case "--noInstall":
                noInstall = true;
                break;
            case "--nProcesses": {
                i++;
                assert(i < argv.length);
                nProcesses = Number.parseInt(argv[i]);
                assert(!Number.isNaN(nProcesses));
                break;
            }
            case "--sharded": {
                i++;
                assert(i < argv.length);
                shardId = Number.parseInt(argv[i]);
                assert(!Number.isNaN(shardId));
                i++;
                assert(i < argv.length);
                shardCount = Number.parseInt(argv[i]);
                assert(!Number.isNaN(shardCount));
                break;
            }
            default:
                throw new Error(`Unexpected arg ${arg}`);
        }
    }

    main(cloneSha || clone, nProcesses, noInstall, onlyTestTsNext, expectOnly, tsLocal, shardId ? {id: shardId, count: shardCount!} : undefined)
        .then(code => {
            if (code !== 0) {
                console.error("FAILED");
            }
            process.exit(code);
        })
        .catch(err => {
            console.error((err as Error).stack);
            process.exit(1);
        });
}

async function main(clone: string | boolean, nProcesses: number, noInstall: boolean, onlyTestTsNext: boolean, expectOnly: boolean, tsLocal: string | undefined, sharding: {id: number, count: number} | undefined): Promise<number> {
    if (clone && !noInstall) {
        await remove(joinPaths(process.cwd(), "DefinitelyTyped"));
        await cloneDt(process.cwd(), typeof clone === "string" ? clone : undefined);
    }

    const dtDir = joinPaths(process.cwd(), clone ? "" : "..", "DefinitelyTyped");
    if (!(await pathExists(dtDir))) {
        throw new Error("Should be run in a directory next to DefinitelyTyped");
    }
    const typesDir = joinPaths(dtDir, "types");

    const allPackages = await getAllPackages(typesDir);
    // Don't shard in order, this way, eg `react` packages are split across all workers
    const testedPackages = sharding ? allPackages.filter((_, i) => (i % sharding.count) === (sharding.id - 1)) : allPackages;

    if (!noInstall) {
        await runOrFail(/*cwd*/ undefined, `node ${pathToDtsLint} --installAll`);
        await installAllDependencies(nProcesses, typesDir, allPackages);
    }

    const allFailures: Array<[string, string]> = [];

    await runWithListeningChildProcesses({
        inputs: testedPackages.map(path => ({ path, onlyTestTsNext, expectOnly })),
        commandLineArgs: tsLocal ? ["--listen", "--localTs", tsLocal] : ["--listen"],
        workerFile: pathToDtsLint,
        nProcesses,
        cwd: typesDir,
        handleOutput(output): void {
            const { path, status } = output as { path: string, status: string };
            if (status === "OK") {
                console.log(`${path} OK`);
            } else {
                console.error(`${path} failing:`);
                console.error(status);
                allFailures.push([path, status]);
            }
        },
    });

    if (allFailures.length === 0) {
        return 0;
    }

    console.error("\n\n=== ERRORS ===\n");

    for (const [path, error] of allFailures) {
        console.error(`\n\nError in ${path}`);
        console.error(error);
    }

    console.error(`The following packages had errors: ${allFailures.map(e => e[0]).join(", ")}`);
    // TODO: If requested, open a bug on Typescript pointing to the devops build log and listing the packages that fail
    return allFailures.length;
}

/**
 * Install all `package.json` dependencies up-front.
 * This ensures that if `types/aaa` depends on `types/zzz`, `types/zzz`'s dependencies will already be installed.
 */
async function installAllDependencies(
    nProcesses: number,
    typesDir: string,
    packages: ReadonlyArray<string>,
): Promise<void> {
    await nAtATime(nProcesses, packages, async packageName => {
        const packagePath = joinPaths(typesDir, packageName);
        if (!await pathExists(joinPaths(packagePath, "package.json"))) {
            return;
        }

        const cmd = "npm install --ignore-scripts --no-shrinkwrap --no-package-lock --no-bin-links";
        console.log(`  ${packagePath}: ${cmd}`);
        await runOrFail(packagePath, cmd);
    });
}

async function cloneDt(cwd: string, sha: string | undefined): Promise<void> {
    if (sha) {
        const cmd = `git init DefinitelyTyped`;
        console.log(cmd);
        await runOrFail(cwd, cmd);
        cwd = `${cwd}/DefinitelyTyped`;
        const commands = [
            `git remote add origin https://github.com/DefinitelyTyped/DefinitelyTyped.git`,
            `git fetch origin master --depth 50`, // We can't clone the commit directly, so we assume the commit is from recent history, pull down some recent commits,
            `git checkout ${sha}` // then check it out
        ];
        for (const command of commands) {
            console.log(command);
            await runOrFail(cwd, command);
        }
        return;
    }
    else {
        const cmd = `git clone https://github.com/DefinitelyTyped/DefinitelyTyped.git --depth 1`;
        console.log(cmd);
        return await runOrFail(cwd, cmd);
    }
}

const exclude = new Set<string>([
    // https://github.com/Microsoft/TypeScript/issues/17862
    "xadesjs",
    // https://github.com/Microsoft/TypeScript/issues/18765
    "strophe",
]);

async function getAllPackages(typesDir: string): Promise<ReadonlyArray<string>> {
    const packageNames = await readdir(typesDir);
    const results = await nAtATime(1, packageNames, async packageName => {
        if (exclude.has(packageName)) {
            return [];
        }
        const packageDir = joinPaths(typesDir, packageName);
        const files = await readdir(packageDir);
        const packages = [packageName];
        for (const file of files) {
            if (/^v\d+$/.test(file)) {
                packages.push(`${packageName}/${file}`);
            }
        }
        return packages;
    });
    return ([] as ReadonlyArray<string>).concat(...results);
}

async function runOrFail(cwd: string | undefined, cmd: string): Promise<void> {
    const err = await run(cwd, cmd);
    if (err !== undefined) {
        throw new Error(err);
    }
}

function run(cwd: string | undefined, cmd: string): Promise<string | undefined> {
    return new Promise<string | undefined>(resolve => {
        exec(cmd, { encoding: "utf8", cwd }, (error, stdoutUntrimmed, stderrUntrimmed) => {
            const stdout = stdoutUntrimmed.trim();
            const stderr = stderrUntrimmed.trim();
            if (stdout !== "") {
                console.log(stdout);
            }
            if (stderr !== "") {
                console.error(stderr);
            }
            // tslint:disable-next-line no-null-keyword strict-type-predicates
            if (error === null) {
                resolve(undefined);
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

interface RunWithListeningChildProcessesOptions<In> {
    readonly inputs: ReadonlyArray<In>;
    readonly commandLineArgs: string[];
    readonly workerFile: string;
    readonly nProcesses: number;
    readonly cwd: string;
    handleOutput(output: {}): void;
}
function runWithListeningChildProcesses<In>(
    { inputs, commandLineArgs, workerFile, nProcesses, cwd, handleOutput }: RunWithListeningChildProcessesOptions<In>,
): Promise<void> {
    return new Promise((resolve, reject) => {
        let inputIndex = 0;
        let processesLeft = nProcesses;
        let rejected = false;
        const allChildren: ChildProcess[] = [];
        for (let i = 0; i < nProcesses; i++) {
            if (inputIndex === inputs.length) {
                processesLeft--;
                continue;
            }

            const child = fork(workerFile, commandLineArgs, { cwd, execArgv: ["--max-old-space-size=4096"] });
            allChildren.push(child);
            child.send(inputs[inputIndex]);
            inputIndex++;

            child.on("message", outputMessage => {
                handleOutput(outputMessage as {});
                if (inputIndex === inputs.length) {
                    processesLeft--;
                    if (processesLeft === 0) {
                        resolve();
                    }
                    child.kill();
                } else {
                    child.send(inputs[inputIndex]);
                    inputIndex++;
                }
            });
            child.on("disconnect", () => {
                if (inputIndex !== inputs.length) {
                    fail();
                }
            });
            child.on("close", () => { assert(rejected || inputIndex === inputs.length); });
            child.on("error", fail);
        }

        function fail(): void {
            rejected = true;
            for (const child of allChildren) {
                child.kill();
            }
            reject(new Error(`Something went wrong in ${runWithListeningChildProcesses.name}`));
        }
    });
}
