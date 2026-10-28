# Device Relay v1 contract fixtures

Golden frames for the `frely.device-relay.v1` WebSocket protocol, shared by the CLI (`src/device/protocol.ts`) and the Frely relay server.
This directory is the single source of truth: the server pins a tag of this repository and checks its own parser against these files.

- `valid/*.json`: `{ description, direction, frame }`. Both ends must accept the frame and re-encode it unchanged. `direction` says who sends it.
- `invalid/*.json`: `{ description, error, frame | raw }`. Both ends must reject it with the given error code. `raw` is sent as text, `frame` as JSON.

Changing a fixture changes the protocol. Add fixtures and release the CLI first, then bump the server's pin.

Request methods in v1 are `mcp` and `provider`. The CLI used to also accept `node`, which no server ever sent; it was removed.
