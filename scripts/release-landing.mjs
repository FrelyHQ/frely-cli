import { main } from "./release-entry.mjs";
try { main(process.argv.slice(2), "landing"); }
catch (error) { console.error(error.message); process.exitCode = 1; }
