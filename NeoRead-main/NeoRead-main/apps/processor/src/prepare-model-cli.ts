import { prepareModel } from "./prepare-model";

const directory = process.argv[2];
if (!directory) throw new Error("Usage: prepare-model DIRECTORY");
await prepareModel(directory, process.env.NEOREAD_BUILD_LAYOUT_MODEL);
