import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { userAgent } from "../../src/fetch/user-agent.js";

const version = (
  JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

describe("userAgent", () => {
  it("carries the package.json version and the project URL", () => {
    expect(userAgent("https://project.example/")).toBe(
      `openplans/${version} (public health-plan source discovery; +https://project.example/)`,
    );
  });
});
