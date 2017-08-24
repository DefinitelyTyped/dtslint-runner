"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
const child_process_1 = require("child_process");
const fs_extra_1 = require("fs-extra");
const path_1 = require("path");
const pathToDtsLint = require.resolve("dtslint");
if (module.parent === null) {
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
async function main(nProcesses, onlyLint) {
    /*const installError = await run(/*cwd* / undefined, pathToDtsLint, "--installAll");
    if (installError !== undefined) {
        return 1;
    }*/
    const dtDir = path_1.join(process.cwd(), "..", "DefinitelyTyped");
    if (!(await fs_extra_1.pathExists(dtDir))) {
        throw new Error("Should be run in a directory next to DefinitelyTyped");
    }
    const allPackages = await getAllPackages(dtDir);
    const packageToErrors = await nAtATime(nProcesses, allPackages, async ({ name, path }) => {
        console.log(name);
        return { name, error: await testPackage(path, onlyLint) };
    });
    const errors = packageToErrors.filter(({ error }) => error !== undefined);
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
const exclude = new Set([
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
async function getAllPackages(dtDir) {
    const typesDir = path_1.join(dtDir, "types");
    const packageNames = await fs_extra_1.readdir(typesDir);
    const results = await nAtATime(1, packageNames, async (packageName) => {
        const packageDir = path_1.join(typesDir, packageName);
        const files = await fs_extra_1.readdir(packageDir);
        const packages = [{ name: packageName, path: packageDir }];
        for (const file of files) {
            if (/^v\d+$/.test(file)) {
                const name = `${packageName}/${file}`;
                if (!exclude.has(name)) {
                    packages.push({ name, path: path_1.join(packageDir, file) });
                }
            }
        }
        return packages;
    });
    return [].concat(...results);
}
async function testPackage(packagePath, onlyLint) {
    const shouldLint = await fs_extra_1.pathExists(path_1.join(packagePath, "tslint.json"));
    if (onlyLint && !shouldLint) {
        return undefined;
    }
    const args = shouldLint ? [] : ["--noLint"];
    return await run(packagePath, pathToDtsLint, ...args);
}
function run(cwd, cmd, ...args) {
    const nodeCmd = `node ${cmd} ${args.join(" ")}`;
    return new Promise(resolve => {
        child_process_1.exec(nodeCmd, { encoding: "utf8", cwd }, (error, stdout, stderr) => {
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
                }
                else {
                    resolve(undefined);
                }
            }
            else {
                resolve(`${error.message}\n${stdout}\n${stderr}`);
            }
        });
    });
}
async function nAtATime(n, inputs, use) {
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
function initArray(length, makeElement) {
    const arr = new Array(length);
    for (let i = 0; i < length; i++) {
        arr[i] = makeElement();
    }
    return arr;
}
