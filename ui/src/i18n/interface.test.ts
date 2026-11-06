import { describe, expect, it } from "vitest";
import { i18n } from ".";
import { DEFAULT_LOCALE } from "./locales";
import { uiText, uiTextFormat } from "./interface";

describe("interface languages", () => {
  it("keeps Chinese as the product default and resolves explicit language choices", async () => {
    expect(DEFAULT_LOCALE).toBe("zh-CN");
    await i18n.changeLanguage("zh-CN");
    expect(uiText("Trust preset")).toBe("信任预设");
    await i18n.changeLanguage("en");
    expect(uiText("Trust preset")).toBe("Trust preset");
  });
  it("preserves runtime values verbatim and falls back for unregistered labels", async () => {
    await i18n.changeLanguage("zh-CN");
    const value = "<User-content __PCVAR0__>";
    expect(uiTextFormat("No __PCVAR0__ available", [value])).toContain(value);
    expect(uiText("unregistered fixture label")).toBe("unregistered fixture label");
  });
});
