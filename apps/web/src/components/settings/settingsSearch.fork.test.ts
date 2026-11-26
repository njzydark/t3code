import { expect, it } from "vite-plus/test";
import { searchSettings } from "./settingsSearch";

it("does not offer telemetry exports or feedback uploads in fork settings search", () => {
  expect(
    searchSettings("OpenTelemetry export").some((item) => item.id === "telemetry-export"),
  ).toBe(false);
  expect(searchSettings("Agent feedback").some((item) => item.id === "agent-feedback")).toBe(false);
  expect(searchSettings("Diagnostics").some((item) => item.id === "diagnostics")).toBe(true);
});
