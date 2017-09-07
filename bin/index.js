"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
const child_process_1 = require("child_process");
const fs_extra_1 = require("fs-extra");
const os_1 = require("os");
const path_1 = require("path");
const pathToDtsLint = require.resolve("dtslint");
if (module.parent === null) {
    let clone = false;
    let onlyLint = false;
    let noInstall = false;
    let nProcesses = os_1.cpus().length;
    const { argv } = process;
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case "--clone": {
                clone = true;
                break;
            }
            case "--noInstall": {
                noInstall = true;
                break;
            }
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
    main(clone, nProcesses, noInstall, onlyLint)
        .then(code => {
        if (code !== 0) {
            console.error("FAILED");
        }
        process.exit(code);
    })
        .catch(err => {
        console.error(err.stack);
        process.exit(1);
    });
}
async function main(clone, nProcesses, noInstall, onlyLint) {
    if (clone && !noInstall) {
        await fs_extra_1.remove(path_1.join(process.cwd(), "DefinitelyTyped"));
        await cloneDt(process.cwd());
    }
    if (!noInstall) {
        await runOrFail(/*cwd*/ undefined, `node ${pathToDtsLint} --installAll`);
    }
    const dtDir = path_1.join(process.cwd(), clone ? "" : "..", "DefinitelyTyped");
    if (!(await fs_extra_1.pathExists(dtDir))) {
        throw new Error("Should be run in a directory next to DefinitelyTyped");
    }
    const allPackages = await getAllPackages(dtDir);
    if (!noInstall) {
        await installAllDependencies(nProcesses, allPackages.map(p => p.path));
    }
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
/**
 * Install all `package.json` dependencies up-front.
 * This ensures that if `types/aaa` depends on `types/zzz`, `types/zzz`'s dependencies will already be installed.
 */
async function installAllDependencies(nProcesses, packagePaths) {
    await nAtATime(nProcesses, packagePaths, async (packagePath) => {
        if (!await fs_extra_1.pathExists(path_1.join(packagePath, "package.json"))) {
            return;
        }
        const cmd = "npm install --ignore-scripts --no-shrinkwrap --no-package-lock --no-bin-links";
        console.log(`  ${packagePath}: ${cmd}`);
        await runOrFail(packagePath, cmd);
    });
}
function cloneDt(cwd) {
    const cmd = "git clone https://github.com/DefinitelyTyped/DefinitelyTyped.git --depth 1";
    console.log(cmd);
    return runOrFail(cwd, cmd);
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
    // https://github.com/Microsoft/TSJS-lib-generator/issues/289
    "chocolatechipjs",
    "isomorphic-fetch",
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
    "react-navigation",
    "ember-testing-helpers",
    "ember",
]);
async function getAllPackages(dtDir) {
    const typesDir = path_1.join(dtDir, "types");
    const packageNames = await fs_extra_1.readdir(typesDir);
    const results = await nAtATime(1, packageNames, async (packageName) => {
        if (exclude.has(packageName)) {
            return [];
        }
        const packageDir = path_1.join(typesDir, packageName);
        const files = await fs_extra_1.readdir(packageDir);
        const packages = [{ name: packageName, path: packageDir }];
        for (const file of files) {
            if (/^v\d+$/.test(file)) {
                const name = `${packageName}/${file}`;
                packages.push({ name, path: path_1.join(packageDir, file) });
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
    const args = shouldLint ? "" : " --noLint";
    return await run(packagePath, `node ${pathToDtsLint}${args}`);
}
async function runOrFail(cwd, cmd) {
    const err = await run(cwd, cmd);
    if (err !== undefined) {
        throw new Error(err);
    }
}
function run(cwd, cmd) {
    return new Promise(resolve => {
        child_process_1.exec(cmd, { encoding: "utf8", cwd }, (error, stdoutUntrimmed, stderrUntrimmed) => {
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
