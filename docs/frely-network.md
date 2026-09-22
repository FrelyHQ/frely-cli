# Frely Network commands

The Network commands are part of the unreleased 0.4.0 source version. The npm distribution requires Node.js 22 or newer; the standalone distribution includes its runtime. Package publication and server activation are separate release steps.

```sh
frely network setup --host chatgpt --json
frely network status --json
frely network find --capability web3.address-risk --json
frely network use --capability web3.address-risk \
  --input-json '{"address":"<EVM_ADDRESS>","chainId":"1"}' \
  --request-id '<REQUEST_UUID>' --json
frely network logout --json
```

The examples contain placeholders. Host values are `chatgpt`, `claude-code`, `opencode` and `generic`. Setup returns a browser link and request code without waiting for a signature or requiring a TTY. The next status or capability call retrieves the authorization. ChatGPT requires an existing device-execution bridge and uses the instructions in its current conversation; setup does not add a ChatGPT connector or native Skill.

`--network <HTTPS-origin>` selects a deployment. Credentials are scoped to that origin in the basic private-file store under `frely-network`; they do not share Frely account or device-relay credentials. Tokens and private device codes are excluded from command output. `logout` affects the Network session, not the existing FrelyMCP service. An unconfirmed remote revocation is reported as an error.

Skill installation manages its own files and hash metadata. An unmanaged file, user edit or symlink causes a failure rather than a configuration overwrite. Installation paths are `.claude/skills/frely-network`, `.config/opencode/skills/frely-network` or `.agents/skills/frely-network` under the user home.

The first address-risk profile requires target chain `1`; the wallet login chain does not choose the target. Service output contains source-backed risk signals and `scamProbability: null`, not a fabricated percentage. Calls use platform demo quota without granting wallet transfer permissions. Preserve the request UUID for retries; the CLI does not resend an ambiguous service call.

CLI unit tests use a fake credential store and temporary home directories. They do not verify the user's OS credential-store permissions or a deployed Network. Source verification:

```sh
npm ci
npm run check
npm test
npm run build
node dist/index.js network help --json
```

The planned unified MCP entry will support wallet-funded capability use without
a Frely account. Current device MCP authorization and demo Network calls do not
implement that complete flow. See [Wallet access plan](mcp-wallet-access-plan.md)
for the accepted product boundary and remaining work.
