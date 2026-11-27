// Shared pre-flight confirmation for every tool that drives FS acquisition
// on the console. The default answer is NO: pressing Enter (or anything
// that is not y/yes) aborts before anything is sent. --yes (passed in as
// assumedYes by the callers) skips the prompt for repeat/automated use —
// the operator has then confirmed the risk explicitly.

import readline from "node:readline/promises";
import {stdin, stdout} from "node:process";

export async function confirmBrickRisk(assumedYes, toolLabel) {
    if (assumedYes) return true;

    console.log();
    console.log("WARNING: all FS-acquisition methods — including this " +
        toolLabel + " —");
    console.log("carry a small but very real risk of BRICKING your " +
        "console. Until");
    console.log("further improvements are made, you should hold off if " +
        "you don't want");
    console.log("this risk.");

    if (!stdin.isTTY) {
        console.log();
        console.log("Non-interactive input — declining by default. " +
            "Re-run with --yes to confirm the risk and proceed.");
        return false;
    }

    const rl = readline.createInterface({input: stdin, output: stdout});
    let answer;
    try {
        answer = await rl.question("Proceed anyway? [y/N] ");
    } finally {
        rl.close();
    }
    if (!/^(y|yes)$/i.test(String(answer).trim())) {
        console.log("Aborted — nothing was sent to the console.");
        return false;
    }
    return true;
}
