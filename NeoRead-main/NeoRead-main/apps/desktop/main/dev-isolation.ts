export function devIsolation({
  isPackaged,
  env,
}: {
  isPackaged: boolean;
  env: NodeJS.ProcessEnv;
}) {
  return {
    userDataDirectory: isPackaged ? null : "NeoRead Dev",
    registerProtocol: isPackaged || env.NEOREAD_DEV_PROTOCOL === "1",
    enableConnector: isPackaged || env.NEOREAD_DEV_CONNECTOR === "1",
  };
}

/** Keep upgrade data in place; do not copy or rename a live library. */
export function packagedProfileDirectory(
  isDirectory: (name: string) => boolean,
) {
  // "Reader" is reserved for the pre-migration application and its schema.
  if (isDirectory("Reader Data")) return "Reader Data";
  if (isDirectory("NeoRead")) return "NeoRead";
  return "Reader Data";
}
