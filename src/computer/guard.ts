/**
 * Hard blocklist for the `computer` toolset (plan computer-use D5): apps that must never be driven
 * remotely, whatever the user enabled. Not configurable. Matching is by the `app` argument that
 * every open-computer-use action tool takes (an app name or bundle identifier).
 */

const BLOCKED_EXACT = new Set([
  // Terminals and shells: a GUI terminal would bypass the read-only CLI permission model.
  "terminal", "iterm", "iterm2", "ghostty", "warp", "kitty", "alacritty", "wezterm", "wezterm-gui", "hyper", "tabby",
  "cmd", "powershell", "pwsh", "windowsterminal", "wt", "conhost", "mintty", "openconsole",
  "gnome-terminal", "gnome-terminal-server", "konsole", "xterm", "uxterm", "tilix", "terminator", "xfce4-terminal", "foot", "lxterminal", "mate-terminal", "ptyxis", "kgx", "gnome-console", "st",
  // Password managers and credential stores.
  "1password", "bitwarden", "keepassxc", "keepass", "lastpass", "dashlane", "enpass", "nordpass", "proton pass", "keychain access", "keychainaccess", "passwords", "seahorse", "gnome-keyring",
  // OS security prompts and privilege escalation dialogs.
  "securityagent", "userinterfacenotificationcenter", "coreservicesuiagent", "uiagent", "consent", "securityhealthsystray", "polkit-gnome-authentication-agent-1", "lxpolkit", "polkit-kde-authentication-agent-1", "pkexec",
  // System settings (security & privacy panes cannot be told apart at app level).
  "system settings", "system preferences", "systemsettings", "systempreferences", "settings", "control panel", "regedit", "gnome-control-center",
  // Frely itself.
  "frely", "frely app", "frely-app", "frely-cli", "frelyapp",
]);

const BLOCKED_PREFIXES = [
  "com.apple.terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty", "dev.warp.", "net.kovidgoyal.kitty", "org.alacritty", "com.github.wez.wezterm", "co.zeit.hyper", "org.tabby",
  "com.1password.", "com.agilebits.", "com.bitwarden.", "org.keepassxc.", "com.lastpass.", "com.dashlane.", "com.enpass.", "com.nordsec.nordpass", "me.proton.pass", "com.apple.keychainaccess", "com.apple.passwords",
  "com.apple.securityagent", "com.apple.coreservices.uiagent", "com.apple.systempreferences", "com.apple.settings", "com.apple.usernotificationcenter",
  "com.frely.", "cloud.frely.",
  "org.gnome.terminal", "org.gnome.console", "org.kde.konsole", "org.gnome.seahorse", "org.keepassxc.", "org.gnome.settings", "org.gnome.controlcenter",
];

export class ComputerBlockedError extends Error {
  constructor(readonly app: string) {
    super(`Computer use is not allowed for "${app}": terminals, password managers, OS security prompts, system settings and Frely itself are always blocked.`);
    this.name = "ComputerBlockedError";
  }
}

export function normalizeApp(value: string): string {
  return value.trim().toLowerCase().replace(/\.(app|exe)$/u, "").replace(/\s+/gu, " ");
}

export function isBlockedApp(app: string): boolean {
  const name = normalizeApp(app);
  if (name === "") return true;
  if (BLOCKED_EXACT.has(name)) return true;
  if (BLOCKED_PREFIXES.some((prefix) => name === prefix.replace(/\.$/u, "") || name.startsWith(prefix))) return true;
  // Names that merely contain a blocked word as a token ("Windows Terminal Preview", "1Password 8").
  const tokens = name.split(/[\s._-]+/u);
  return tokens.some((token) => token === "terminal" || token === "iterm2" || token === "powershell" || token === "1password" || token === "keepassxc" || token === "bitwarden");
}

/**
 * The `app` argument must name an app. A bare number is a process id and a long free-form string is
 * a window title: both could point at a blocked app while slipping past a name match, so they are refused.
 */
export function assertAppAllowed(app: unknown): string {
  if (typeof app !== "string" || app.trim() === "") throw new Error("app must be a non-empty app name or bundle identifier.");
  if (/^\d+$/u.test(app.trim())) throw new Error("Process ids are not accepted; pass the app name or bundle identifier from computer_list_apps.");
  if (app.length > 200) throw new Error("app is too long; pass the app name or bundle identifier.");
  if (isBlockedApp(app)) throw new ComputerBlockedError(app);
  return app;
}

/** Drop whole lines that mention a blocked app, so list_apps never advertises one. */
export function redactBlockedAppLines(text: string): string {
  return text.split("\n").filter((line) => !lineMentionsBlockedApp(line)).join("\n");
}

function lineMentionsBlockedApp(line: string): boolean {
  const lowered = line.toLowerCase();
  if (BLOCKED_PREFIXES.some((prefix) => lowered.includes(prefix))) return true;
  const words = lowered.split(/[^a-z0-9.\-+]+/u).filter(Boolean);
  const phrases = new Set<string>();
  for (let i = 0; i < words.length; i += 1) {
    phrases.add(words[i]!);
    if (words[i + 1]) phrases.add(`${words[i]} ${words[i + 1]}`);
  }
  return [...phrases].some((phrase) => isBlockedApp(phrase) && phrase !== "settings" && phrase !== "st" && phrase !== "cmd" && phrase !== "wt");
}
