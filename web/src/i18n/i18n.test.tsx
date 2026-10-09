import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { I18nProvider, translate, useI18n, useT } from "./index.js";
import { zhCN } from "./zh-CN.js";
import { en } from "./en.js";

describe("i18n", () => {
  it("defaults to zh-CN without a provider", () => {
    function Label() { return <span>{useT()("sidebar.newSession")}</span>; }
    render(<Label />);
    expect(screen.getByText("新建会话")).toBeInTheDocument();
  });

  it("interpolates params and leaves unknown placeholders visible", () => {
    expect(translate("zh-CN", "turn.thought", { seconds: 4 })).toBe("已思考 4 秒");
    expect(translate("en", "turn.thought", { seconds: 4 })).toBe("Thought for 4s");
    expect(translate("zh-CN", "turn.thought")).toBe("已思考 {seconds} 秒");
    expect(translate("zh-CN", "turn.thought", {})).toBe("已思考 {seconds} 秒");
  });

  it("switches locale through the provider", () => {
    function Switcher() {
      const { t, setLocale } = useI18n();
      return <button onClick={() => setLocale("en")}>{t("composer.send")}</button>;
    }
    render(<I18nProvider><Switcher /></I18nProvider>);
    act(() => screen.getByRole("button").click());
    expect(screen.getByRole("button")).toHaveTextContent("Send");
  });

  it("keeps every locale on the same key set and placeholders", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
    const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(zhCN) as Array<keyof typeof zhCN>) {
      expect(placeholders(en[key]), key).toEqual(placeholders(zhCN[key]));
    }
  });
});
