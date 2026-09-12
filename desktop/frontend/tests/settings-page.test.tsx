import { render, screen, fireEvent } from "@testing-library/react";
import { it, expect, vi } from "vitest";
import { SettingsPage } from "../src/features/settings/SettingsPage";
import { Default } from "../src/lib/bindings"; // 见 Step 6 的类型再导出

vi.mock("../src/app/i18n", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

it("saves picked theme and language", async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<SettingsPage settings={Default()} onSave={onSave} />);
  fireEvent.change(screen.getByLabelText("settings.theme"), { target: { value: "dark" } });
  fireEvent.change(screen.getByLabelText("settings.language"), { target: { value: "zh-CN" } });
  fireEvent.click(screen.getByRole("button", { name: "common.save" }));
  await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
  const saved = onSave.mock.calls[0][0];
  expect(saved.appearance.theme).toBe("dark");
  expect(saved.appearance.language).toBe("zh-CN");
});

it("renders confirm_level (default standard) and carries the change into SaveSettings", async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<SettingsPage settings={Default()} onSave={onSave} />);
  const select = screen.getByLabelText("settings.confirmLevel.label") as HTMLSelectElement;
  expect(select.value).toBe("standard");
  fireEvent.change(select, { target: { value: "relaxed" } });
  fireEvent.click(screen.getByRole("button", { name: "common.save" }));
  await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
  expect(onSave.mock.calls[0][0].behavior.confirm_level).toBe("relaxed");
});
