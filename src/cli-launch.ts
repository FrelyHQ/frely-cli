declare const FRELY_STANDALONE: boolean | undefined;
export const IS_STANDALONE = typeof FRELY_STANDALONE === "boolean" && FRELY_STANDALONE;

export function cliLaunchArguments(entry: string, args: string[], standalone = IS_STANDALONE, executable = process.execPath): string[] {
  return standalone ? [executable, ...args] : [executable, entry, ...args];
}
