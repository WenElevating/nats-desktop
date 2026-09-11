import { render, screen, fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import { Shell } from "../src/app/shell";

vi.mock("../src/app/i18n", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@wailsio/runtime", () => ({
  Events: { On: vi.fn(() => () => {}) },
  System: { IsDarkMode: vi.fn(async () => false) },
}));

it("renders all eight nav entries with svg icons", () => {
  render(<Shell page="settings" onNavigate={() => {}}><div/></Shell>);
  for (const key of ["dashboard","messages","streams","consumers","kv","objects","monitoring","settings"]) {
    expect(screen.getByTestId(`nav-${key}`)).toBeTruthy();
  }
  // 规格 §18.2：禁止 emoji 图标 —— 导航按钮内只允许 svg
  const btn = screen.getByTestId("nav-streams");
  expect(btn.querySelector("svg")).toBeTruthy();
  expect(btn.textContent).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
});

it("active nav item is marked", () => {
  render(<Shell page="streams" onNavigate={() => {}}><div/></Shell>);
  expect(screen.getByTestId("nav-streams").getAttribute("aria-current")).toBe("page");
});

it("calls onNavigate on click", () => {
  const nav = vi.fn();
  render(<Shell page="settings" onNavigate={nav}><div/></Shell>);
  fireEvent.click(screen.getByTestId("nav-kv"));
  expect(nav).toHaveBeenCalledWith("kv");
});

// ---- Additional shell coverage (same contracts as above) ----

it("shows the disconnected empty state on non-settings pages when not connected", () => {
  render(
    <Shell page="streams" onNavigate={() => {}}>
      <div data-testid="page-content" />
    </Shell>,
  );
  expect(screen.getByTestId("empty-state")).toBeTruthy();
  expect(screen.queryByTestId("page-content")).toBeNull();
});

it("renders children when connected", () => {
  render(
    <Shell page="streams" onNavigate={() => {}} conn={{ state: "connected", context: "dev", rttMs: 12, reason: "" }}>
      <div data-testid="page-content" />
    </Shell>,
  );
  expect(screen.getByTestId("page-content")).toBeTruthy();
  expect(screen.queryByTestId("empty-state")).toBeNull();
});

it("failed connection shows the banner with a fix button that navigates to settings", () => {
  const nav = vi.fn();
  render(
    <Shell page="streams" onNavigate={nav} conn={{ state: "failed", context: "dev", rttMs: 0, reason: "boom" }}>
      <div />
    </Shell>,
  );
  const banner = screen.getByTestId("conn-banner");
  expect(banner.textContent).toContain("conn.bannerFailed");
  fireEvent.click(screen.getByTestId("conn-fix"));
  expect(nav).toHaveBeenCalledWith("settings");
});
