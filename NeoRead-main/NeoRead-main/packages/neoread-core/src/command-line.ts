/** Whether the `neoread` command is on the user's PATH, from the desktop shell. */
export interface CommandLineStatus {
  /** False in development builds and on platforms without an installer. */
  supported: boolean;
  installed: boolean;
  /** The link (macOS) or PATH directory (Windows) that provides `neoread`. */
  location: string;
  /** Another program already uses the location; NeoRead leaves it alone. */
  conflict?: boolean;
}
