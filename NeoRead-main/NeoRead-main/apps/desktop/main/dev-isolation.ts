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
