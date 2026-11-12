import { expect, it } from "vitest";
import { devIsolation } from "./dev-isolation";

it("keeps packaged behavior regardless of development opt-ins", () => {
  for (const env of [
    {},
    { NEOREAD_DEV_PROTOCOL: "0", NEOREAD_DEV_CONNECTOR: "0" },
  ]) {
    expect(devIsolation({ isPackaged: true, env })).toEqual({
      userDataDirectory: null,
      registerProtocol: true,
      enableConnector: true,
    });
  }
});

it("isolates unpackaged runs by default", () => {
  expect(devIsolation({ isPackaged: false, env: {} })).toEqual({
    userDataDirectory: "NeoRead Dev",
    registerProtocol: false,
    enableConnector: false,
  });
});

it("enables only explicitly opted-in development integrations", () => {
  expect(
    devIsolation({ isPackaged: false, env: { NEOREAD_DEV_PROTOCOL: "1" } }),
  ).toEqual({
    userDataDirectory: "NeoRead Dev",
    registerProtocol: true,
    enableConnector: false,
  });
  expect(
    devIsolation({ isPackaged: false, env: { NEOREAD_DEV_CONNECTOR: "1" } }),
  ).toEqual({
    userDataDirectory: "NeoRead Dev",
    registerProtocol: false,
    enableConnector: true,
  });
});
