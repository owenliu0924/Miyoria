// A program for the sandbox launcher's tests: echoes its stdin, ends with it.
import process from "node:process";

process.stdin.pipe(process.stdout);
process.stdin.on("end", () => process.exit(0));
