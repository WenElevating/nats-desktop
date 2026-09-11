import { render, screen, fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import { CommandPalette } from "../src/app/command";

vi.mock("../src/app/i18n", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

it("palette lists all pages and navigates on select", async () => {
  const nav = vi.fn();
  render(
    <CommandPalette open onClose={vi.fn()} onNavigate={nav} contexts={[]} onSwitchContext={vi.fn()} />,
  );
  for (const key of ["dashboard", "streams", "settings"]) {
    expect(await screen.findByTestId(`cmd-${key}`)).toBeTruthy();
  }
  fireEvent.click(screen.getByTestId("cmd-streams"));
  expect(nav).toHaveBeenCalledWith("streams");
});

it("palette switches context on select", async () => {
  const sw = vi.fn();
  render(
    <CommandPalette open onClose={vi.fn()} onNavigate={vi.fn()} contexts={["dev", "prod"]} onSwitchContext={sw} />,
  );
  fireEvent.click(await screen.findByTestId("cmd-ctx-dev"));
  expect(sw).toHaveBeenCalledWith("dev");
});

it("palette hides nothing-pressed extras when closed", () => {
  render(
    <CommandPalette open={false} onClose={vi.fn()} onNavigate={vi.fn()} contexts={["dev"]} onSwitchContext={vi.fn()} />,
  );
  expect(screen.queryByTestId("cmd-streams")).toBeNull();
});
