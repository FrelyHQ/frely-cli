const expected = process.env.EXPECTED_SHA;
if (!/^[0-9a-f]{40}$/.test(expected || "")) throw new Error("Expected source SHA is required");
let passed = false;
for (let attempt = 0; attempt < 12; attempt++) {
  try {
    const response = await fetch("https://cli.frely.cloud/release.json?sha=" + expected, {cache: "no-store", signal: AbortSignal.timeout(10000)});
    if (response.ok && (await response.json()).sourceSha === expected) { passed = true; break; }
  } catch {}
  if (attempt < 11) await new Promise(resolve => setTimeout(resolve, 5000));
}
if (!passed) throw new Error("CLI Landing did not expose the expected source SHA");
console.log("CLI Landing release marker verified");
