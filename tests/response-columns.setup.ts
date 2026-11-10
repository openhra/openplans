import { vi } from "vitest";
import type * as App from "../src/api/app.js";
import { checkResponses } from "./response-columns.js";

// Every test that builds the API app checks each JSON response for row provenance columns.
vi.mock("../src/api/app.js", async (importOriginal) => {
  const module = await importOriginal<typeof App>();
  return {
    ...module,
    createApp: (...parameters: Parameters<typeof App.createApp>) =>
      checkResponses(module.createApp(...parameters)),
  };
});
