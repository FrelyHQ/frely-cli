import { StdioOcuBackend } from "./ocu.js";
import { readComputerSwitch } from "./state.js";
import { ComputerToolset } from "./toolset.js";

export { COMPUTER_TOOLSET_ID } from "./toolset.js";

export function createComputerToolset(): ComputerToolset {
  return new ComputerToolset({ backend: new StdioOcuBackend(), isLocallyEnabled: async () => (await readComputerSwitch()) !== null });
}
