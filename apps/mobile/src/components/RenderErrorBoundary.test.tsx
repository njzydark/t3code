import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  ScrollView: ({ children }: { children?: ReactNode }) => children,
  View: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("./ui/AppText", () => ({ AppText: () => null }));
vi.mock("./ui/Button", () => ({ Button: () => null }));
vi.mock("../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));

import { RenderErrorBoundary } from "./RenderErrorBoundary";

it("keeps render errors local and lets the user retry without loading Observe", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  using log = vi.spyOn(console, "error").mockImplementation(() => {});
  const container = document.createElement("div");
  const root = createRoot(container);
  const error = new Error("Local render failure");
  let broken = true;
  function Screen() {
    if (broken) throw error;
    return <span>Recovered</span>;
  }
  try {
    await act(async () =>
      root.render(
        <RenderErrorBoundary
          renderFallback={({ details, retry }) => <button onClick={retry}>{details}</button>}
        >
          <Screen />
        </RenderErrorBoundary>,
      ),
    );
    expect(container.textContent).toContain("Local render failure");
    expect(container.textContent).toContain("Component stack:");
    expect(log).toHaveBeenCalledWith(
      "[render] screen could not be displayed",
      error,
      expect.stringContaining("Screen"),
    );
    broken = false;
    await act(async () => container.querySelector("button")?.click());
    expect(container.textContent).toBe("Recovered");
  } finally {
    await act(async () => root.unmount());
  }
});
