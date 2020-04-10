import assert = require("assert");
import { ChildProcess, exec, fork, execSync } from "child_process";
import { pathExists, readdir, remove } from "fs-extra";
import { cpus, homedir } from "os";
import { join as joinPaths } from "path";
import { readdirSync, readFileSync } from 'fs';
import { percentile } from 'stats-lite';

const DEFAULT_CRASH_RECOVERY_MAX_OLD_SPACE_SIZE = 4096;

const pathToDtsLint = require.resolve("dtslint");
const perfDir = joinPaths(homedir(), ".dts", "perf");

if (module.parent === null) { // tslint:disable-line no-null-keyword
    let clone = false;
    let cloneSha: string | undefined;
    let noInstall = false;
    let tsLocal: string | undefined;
    let onlyTestTsNext = false;
    let expectOnly = false;
    let nProcesses = cpus().length;
    let shard: { id: number, count: number } | undefined;
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
                } else if (argv[i + 1].startsWith("--")) {
                    throw new Error(`Looking for local path for TS, but got ${tsLocal}`);
                } else {
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
                const shardId = Number.parseInt(argv[i]);
                assert(!Number.isNaN(shardId));
                i++;
                assert(i < argv.length);
                const shardCount = Number.parseInt(argv[i]);
                assert(!Number.isNaN(shardCount));
                shard = { id: shardId, count: shardCount };
                break;
            }
            default:
                throw new Error(`Unexpected arg ${arg}`);
        }
    }

    main(cloneSha || clone, nProcesses, noInstall, onlyTestTsNext, expectOnly, tsLocal, shard)
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

async function main(
    clone: string | boolean, nProcesses: number, noInstall: boolean, onlyTestTsNext: boolean, expectOnly: boolean,
    tsLocal: string | undefined, sharding: {id: number, count: number} | undefined): Promise<number> {
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
    const testedPackages = sharding ? allPackages.filter((_, i) => (i % sharding.count) === (sharding.id - 1)) :
        allPackages;
    const expectedFailures = new Set((readFileSync(joinPaths(__dirname, "../expectedFailures.txt"), "utf8") as string).split("\n").filter(Boolean).map(s => s.trim()));

    if (!noInstall) {
        await runOrFail(/*cwd*/ undefined, `node ${pathToDtsLint} --installAll`);
        await installAllDependencies(typesDir, allPackages);
    }

    const allFailures: Array<[string, string]> = [];

    await runWithListeningChildProcesses({
        inputs: testedPackages.map(path => ({ path, onlyTestTsNext, expectOnly })),
        commandLineArgs: tsLocal ? ["--listen", "--localTs", tsLocal] : ["--listen"],
        workerFile: pathToDtsLint,
        nProcesses,
        cwd: typesDir,
        crashRecovery: true,
        crashRecoveryMaxOldSpaceSize: 0, // disable retry with more memory
        handleStart(input, processIndex): void {
            const prefix = processIndex === undefined ? "" : `${processIndex}> `;
            console.log(`${prefix}${input.path} START`);
        },
        handleOutput(output, processIndex): void {
            const prefix = processIndex === undefined ? "" : `${processIndex}> `;
            const { path, status } = output as { path: string, status: string };
            if (expectedFailures.has(path)) {
                if (status === "OK") {
                    console.error(`${prefix}${path} passed, but was expected to fail.`);
                    allFailures.push([path, status]);
                } else {
                    console.error(`${prefix}${path} failed as expected:`);
                    console.error(prefix ? status.split(/\r?\n/).map(line => `${prefix}${line}`).join("\n") : status);
                }
            } else if (status === "OK") {
                console.log(`${prefix}${path} OK`);
                console.log(execSync('df -h').toString());
            } else {
                console.error(`${prefix}${path} failing:`);
                console.error(prefix ? status.split(/\r?\n/).map(line => `${prefix}${line}`).join("\n") : status);
                allFailures.push([path, status]);
            }
        },
        handleCrash(input, state, processIndex): void {
            const prefix = processIndex === undefined ? "" : `${processIndex}> `;
            switch (state) {
                case CrashRecoveryState.Retry:
                    console.warn(`${prefix}${input.path} Out of memory: retrying`);
                    break;
                case CrashRecoveryState.RetryWithMoreMemory:
                    console.warn(`${prefix}${input.path} Out of memory: retrying with increased memory (4096M)`);
                    break;
                case CrashRecoveryState.Crashed:
                    console.error(`${prefix}${input.path} Out of memory: failed`);
                    allFailures.push([input.path, "Out of memory"]);
                    break;
                default:
            }
        },
    });

    logPerformance();

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

function logPerformance() {
    console.log("\n\n=== PERFORMANCE ===\n");
    let big: Array<[string, number]> = [];
    let types: number[] = [];
    for (const filename of readdirSync(perfDir, { encoding: "utf8" })) {
        const x = JSON.parse(readFileSync(joinPaths(perfDir, filename), { encoding: 'utf8' })) as { [s: string]: { typeCount: number, memory: number } };
        for (const k of Object.keys(x)) {
            big.push([k, x[k].typeCount]);
            types.push(x[k].typeCount);
        }
    }
    console.log("{" + big.sort((a, b) => b[1] - a[1]).map(([name, count]) => ` "${name}": ${count}`).join(",") + "}");

    console.log("  * Percentiles: ");
    console.log("99:", percentile(types, 0.99));
    console.log("95:", percentile(types, 0.95));
    console.log("90:", percentile(types, 0.90));
    console.log("70:", percentile(types, 0.70));
    console.log("50:", percentile(types, 0.50));
}

/**
 * Install all `package.json` dependencies up-front.
 * This ensures that if `types/aaa` depends on `types/zzz`, `types/zzz`'s dependencies will already be installed.
 */
async function installAllDependencies(
    typesDir: string,
    packages: ReadonlyArray<string>,
): Promise<void> {
    for (const packageName of packages) {
        const packagePath = joinPaths(typesDir, packageName);
        if (!await pathExists(joinPaths(packagePath, "package.json"))) {
            continue;
        }

        const cmd = "npm install --ignore-scripts --no-shrinkwrap --no-package-lock --no-bin-links";
        console.log(`  ${packagePath}: ${cmd}`);
        await runOrFail(packagePath, cmd);
    }
}

async function cloneDt(cwd: string, sha: string | undefined): Promise<void> {
    if (sha) {
        const cmd = "git init DefinitelyTyped";
        console.log(cmd);
        await runOrFail(cwd, cmd);
        // tslint:disable-next-line:no-parameter-reassignment
        cwd = `${cwd}/DefinitelyTyped`;
        const commands = [
            "git remote add origin https://github.com/DefinitelyTyped/DefinitelyTyped.git",
            "git fetch origin master --depth 50", // We can't clone the commit directly, so assume the commit is from
            `git checkout ${sha}`,                // recent history, pull down some recent commits, then check it out
        ];
        for (const command of commands) {
            console.log(command);
            await runOrFail(cwd, command);
        }
    } else {
        const cmd = "git clone https://github.com/DefinitelyTyped/DefinitelyTyped.git --depth 1";
        console.log(cmd);
        await runOrFail(cwd, cmd);
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

const enum CrashRecoveryState {
    Normal,
    Retry,
    RetryWithMoreMemory,
    Crashed,
}

interface RunWithListeningChildProcessesOptions<In> {
    readonly inputs: ReadonlyArray<In>;
    readonly commandLineArgs: string[];
    readonly workerFile: string;
    readonly nProcesses: number;
    readonly cwd: string;
    readonly crashRecovery?: boolean;
    readonly crashRecoveryMaxOldSpaceSize?: number;
    handleOutput(output: {}, processIndex: number | undefined): void;
    handleStart?(input: In, processIndex: number | undefined): void;
    handleCrash?(input: In, state: CrashRecoveryState, processIndex: number | undefined): void;
}
function runWithListeningChildProcesses<In>(
    { inputs, commandLineArgs, workerFile, nProcesses, cwd, handleOutput, crashRecovery,
      crashRecoveryMaxOldSpaceSize = DEFAULT_CRASH_RECOVERY_MAX_OLD_SPACE_SIZE,
      handleStart, handleCrash }: RunWithListeningChildProcessesOptions<In>,
): Promise<void> {
    return new Promise((resolve, reject) => {
        let inputIndex = 0;
        let processesLeft = nProcesses;
        let rejected = false;
        const runningChildren = new Set<ChildProcess>();
        const maxOldSpaceSize = getMaxOldSpaceSize(process.execArgv) || 0;
        for (let i = 0; i < nProcesses; i++) {
            if (inputIndex === inputs.length) {
                processesLeft--;
                continue;
            }

            const processIndex = nProcesses > 1 ? i + 1 : undefined;
            let child: ChildProcess;
            let crashRecoveryState = CrashRecoveryState.Normal;
            let currentInput: In;

            const onMessage = (outputMessage: unknown) => {
                try {
                    const oldCrashRecoveryState = crashRecoveryState;
                    crashRecoveryState = CrashRecoveryState.Normal;
                    handleOutput(outputMessage as {}, processIndex);
                    if (inputIndex === inputs.length) {
                        stopChild(/*done*/ true);
                    } else {
                        if (oldCrashRecoveryState !== CrashRecoveryState.Normal) {
                            // retry attempt succeeded, restart the child for further tests.
                            console.log(`${processIndex}> Restarting...`);
                            restartChild(nextTask, process.execArgv);
                        } else {
                            nextTask();
                        }
                    }
                } catch (e) {
                    onError(e);
                }
            };

            const onClose = () => {
                if (rejected || !runningChildren.has(child)) {
                    return;
                }

                try {
                    // treat any unhandled closures of the child as a crash
                    if (crashRecovery) {
                        switch (crashRecoveryState) {
                            case CrashRecoveryState.Normal:
                                crashRecoveryState = CrashRecoveryState.Retry;
                                break;
                            case CrashRecoveryState.Retry:
                                // skip crash recovery if we're already passing a value for --max_old_space_size that
                                // is >= crashRecoveryMaxOldSpaceSize
                                crashRecoveryState = maxOldSpaceSize < crashRecoveryMaxOldSpaceSize
                                    ? CrashRecoveryState.RetryWithMoreMemory
                                    : crashRecoveryState = CrashRecoveryState.Crashed;
                                break;
                            default:
                                crashRecoveryState = CrashRecoveryState.Crashed;
                        }
                    } else {
                        crashRecoveryState = CrashRecoveryState.Crashed;
                    }

                    if (handleCrash) {
                        handleCrash(currentInput, crashRecoveryState, processIndex);
                    }

                    switch (crashRecoveryState) {
                        case CrashRecoveryState.Retry:
                            restartChild(resumeTask, process.execArgv);
                            break;
                        case CrashRecoveryState.RetryWithMoreMemory:
                            restartChild(resumeTask, [
                                ...getExecArgvWithoutMaxOldSpaceSize(),
                                `--max_old_space_size=${crashRecoveryMaxOldSpaceSize}`,
                            ]);
                            break;
                        case CrashRecoveryState.Crashed:
                            crashRecoveryState = CrashRecoveryState.Normal;
                            if (inputIndex === inputs.length) {
                                stopChild(/*done*/ true);
                            } else {
                                restartChild(nextTask, process.execArgv);
                            }
                            break;
                        default:
                            assert.fail(`${processIndex}> Unexpected crashRecoveryState: ${crashRecoveryState}`);
                    }
                } catch (e) {
                    onError(e);
                }
            };

            const onError = (err?: Error) => {
                child.removeAllListeners();
                runningChildren.delete(child);
                fail(err);
            };

            const startChild = (taskAction: () => void, execArgv: string[]) => {
                try {
                    child = fork(workerFile, commandLineArgs, { cwd, execArgv });
                    runningChildren.add(child);
                } catch (e) {
                    fail(e);
                    return;
                }

                try {
                    let closed = false;
                    const thisChild = child;
                    const onChildClosed = () => {
                        // Don't invoke `onClose` more than once for a single child.
                        if (!closed && child === thisChild) {
                            closed = true;
                            onClose();
                        }
                    };
                    const onChildDisconnectedOrExited = () => {
                        if (!closed && thisChild === child) {
                            // Invoke `onClose` after enough time has elapsed to allow `close` to be triggered.
                            // This is to ensure our `onClose` logic gets called in some conditions
                            const timeout = 1000;
                            setTimeout(onChildClosed, timeout);
                        }
                    };
                    child.on("message", onMessage);
                    child.on("close", onChildClosed);
                    child.on("disconnect", onChildDisconnectedOrExited);
                    child.on("exit", onChildDisconnectedOrExited);
                    child.on("error", onError);
                    taskAction();
                } catch (e) {
                    onError(e);
                }
            };

            const stopChild = (done: boolean) => {
                try {
                    assert(runningChildren.has(child), `${processIndex}> Child not running`);
                    if (done) {
                        processesLeft--;
                        if (processesLeft === 0) {
                            resolve();
                        }
                    }
                    runningChildren.delete(child);
                    child.removeAllListeners();
                    child.kill();
                } catch (e) {
                    onError(e);
                }
            };

            const restartChild = (taskAction: () => void, execArgv: string[]) => {
                try {
                    assert(runningChildren.has(child), `${processIndex}> Child not running`);
                    console.log(`${processIndex}> Restarting...`);
                    stopChild(/*done*/ false);
                    startChild(taskAction, execArgv);
                } catch (e) {
                    onError(e);
                }
            };

            const resumeTask = () => {
                try {
                    assert(runningChildren.has(child), `${processIndex}> Child not running`);
                    child.send(currentInput);
                } catch (e) {
                    onError(e);
                }
            };

            const nextTask = () => {
                try {
                    assert(runningChildren.has(child), `${processIndex}> Child not running`);
                    currentInput = inputs[inputIndex];
                    inputIndex++;
                    if (handleStart) {
                        handleStart(currentInput, processIndex);
                    }
                    child.send(currentInput);
                } catch (e) {
                    onError(e);
                }
            };

            startChild(nextTask, process.execArgv);
        }

        function fail(err?: Error): void {
            if (!rejected) {
                rejected = true;
                for (const child of runningChildren) {
                    try {
                        child.removeAllListeners();
                        child.kill();
                    } catch {
                        // do nothing
                    }
                }
                const message = err ? `: ${err.message}` : "";
                reject(new Error(`Something went wrong in ${runWithListeningChildProcesses.name}${message}`));
            }
        }
    });
}

const maxOldSpaceSizeRegExp = /^--max[-_]old[-_]space[-_]size(?:$|=(\d+))/;

interface MaxOldSpaceSizeArgument {
    index: number;
    size: number;
    value: number | undefined;
}

function getMaxOldSpaceSizeArg(argv: ReadonlyArray<string>): MaxOldSpaceSizeArgument | undefined {
    for (let index = 0; index < argv.length; index++) {
        const match = maxOldSpaceSizeRegExp.exec(argv[index]);
        if (match) {
            const value = match[1] ? parseInt(match[1], 10) :
                argv[index + 1] ? parseInt(argv[index + 1], 10) :
                undefined;
            const size = match[1] ? 1 : 2; // tslint:disable-line:no-magic-numbers
            return { index, size, value };
        }
    }
    return undefined;
}

function getMaxOldSpaceSize(argv: ReadonlyArray<string>): number | undefined {
    const arg = getMaxOldSpaceSizeArg(argv);
    return arg && arg.value;
}

let execArgvWithoutMaxOldSpaceSize: ReadonlyArray<string> | undefined;

function getExecArgvWithoutMaxOldSpaceSize(): ReadonlyArray<string> {
    if (!execArgvWithoutMaxOldSpaceSize) {
        // remove --max_old_space_size from execArgv
        const execArgv = process.execArgv.slice();
        let maxOldSpaceSizeArg = getMaxOldSpaceSizeArg(execArgv);
        while (maxOldSpaceSizeArg) {
            execArgv.splice(maxOldSpaceSizeArg.index, maxOldSpaceSizeArg.size);
            maxOldSpaceSizeArg = getMaxOldSpaceSizeArg(execArgv);
        }
        execArgvWithoutMaxOldSpaceSize = execArgv;
    }
    return execArgvWithoutMaxOldSpaceSize;
}
