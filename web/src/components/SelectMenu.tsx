import { zhCN } from "../i18n/zh-CN.js";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Icon, type IconName } from "./Icon.js";
import type { KeyboardEvent } from "react";

/** 列表离触发按钮的距离、离视口边缘的最小留白（px）。 */
const POPUP_GAP = 4;
const VIEWPORT_MARGIN = 8;
/** 不支持 Popover API 的环境（旧浏览器、jsdom）不加 popover 属性，退化为 position: fixed。 */
const SUPPORTS_POPOVER = typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype;

/**
 * 把列表摆到锚点旁边：默认在下方，下方放不下且上方更宽裕时翻到上方；
 * 高度不超过所在一侧的可用空间，水平方向不超出视口。
 */
function placePopup(anchor: HTMLElement, popup: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  popup.style.setProperty("--select-menu-anchor-width", `${rect.width}px`);
  popup.style.removeProperty("--select-menu-room");
  const below = window.innerHeight - rect.bottom - POPUP_GAP - VIEWPORT_MARGIN;
  const above = rect.top - POPUP_GAP - VIEWPORT_MARGIN;
  const up = popup.offsetHeight > below && above > below;
  popup.style.setProperty("--select-menu-room", `${Math.max(0, up ? above : below)}px`);
  const maxLeft = window.innerWidth - VIEWPORT_MARGIN - popup.offsetWidth;
  popup.style.left = `${Math.max(VIEWPORT_MARGIN, Math.min(rect.left, maxLeft))}px`;
  popup.style.top = `${up ? rect.top - POPUP_GAP - popup.offsetHeight : rect.bottom + POPUP_GAP}px`;
  popup.dataset.side = up ? "top" : "bottom";
}

export type SelectMenuOption = { value: string; label: string; title?: string; testId?: string };

export type SelectMenuAction = {
  label: string;
  testId?: string;
  icon?: ReactNode;
  onSelect: () => void;
};

export type SelectMenuProps = {
  options: SelectMenuOption[];
  action?: SelectMenuAction;
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  /** 触发按钮的 id，供外部 `<label htmlFor>` 关联。 */
  id?: string;
  /** 选中项没有自己的 title 时，触发按钮的提示。 */
  title?: string;
  disabled?: boolean;
  testId?: string;
  className?: string;
  placeholder?: string;
  checkPosition?: "left" | "right";
  chevronIcon?: IconName;
  openChevronIcon?: IconName;
  /** 列表对齐的元素，默认是触发按钮。 */
  anchorRef?: RefObject<HTMLElement | null>;
};

/** 通用受控自绘选择器。 */
export function SelectMenu({
  options,
  action,
  value,
  onChange,
  ariaLabel,
  id: triggerId,
  title,
  disabled,
  testId,
  className,
  placeholder = zhCN.select.placeholder,
  checkPosition = "right",
  chevronIcon = "down",
  openChevronIcon,
  anchorRef,
}: SelectMenuProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const listboxId = `${id}-listbox`;
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const hasAction = Boolean(action);
  const itemCount = options.length + (hasAction ? 1 : 0);
  const isDisabled = disabled || itemCount === 0;
  const classes = ["select-menu", className].filter(Boolean).join(" ");

  // 列表放进 top layer（popover），不会被弹窗、侧栏等滚动容器截住，也能盖在 <dialog> 之上；
  // 它在 DOM 里仍是本组件的子节点，点外面关闭和焦点逻辑不受影响。
  useLayoutEffect(() => {
    const popup = listboxRef.current;
    const anchor = anchorRef?.current ?? triggerRef.current;
    if (!open || !popup || !anchor) return;
    if (SUPPORTS_POPOVER && !popup.matches(":popover-open")) popup.showPopover();
    const place = () => placePopup(anchor, popup);
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, options.length, hasAction, anchorRef]);

  useEffect(() => {
    if (!open) return;
    listboxRef.current?.focus();
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (isDisabled) setOpen(false);
  }, [isDisabled]);

  useEffect(() => {
    if (!open || isDisabled) return;
    const optionElements = listboxRef.current?.querySelectorAll<HTMLElement>('[role="option"], [role="menuitemradio"], [role="menuitem"]');
    const option = optionElements?.item(activeIndex) ?? null;
    option?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex, isDisabled]);

  function openMenu(index = selectedIndex >= 0 ? selectedIndex : 0): void {
    if (isDisabled) return;
    const maxIndex = Math.max(0, itemCount - 1);
    setActiveIndex(Math.max(0, Math.min(index, maxIndex)));
    setOpen(true);
  }

  function closeMenu(restoreFocus = false): void {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function choose(index: number): void {
    if (isDisabled) return;
    if (index < options.length) {
      const option = options[index];
      if (!option) return;
      onChange(option.value);
      closeMenu(true);
    } else if (action && index === options.length) {
      action.onSelect();
      closeMenu(false);
    }
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (isDisabled || open) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openMenu(event.key === "ArrowUp" && selectedIndex < 0 ? itemCount - 1 : selectedIndex);
    } else if (event.key === "Home") {
      event.preventDefault();
      openMenu(0);
    } else if (event.key === "End") {
      event.preventDefault();
      openMenu(itemCount - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMenu();
    }
  }

  function handleListboxKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (isDisabled) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (action && options.length > 0) {
          setActiveIndex((index) => (index >= options.length ? 0 : (index + 1) % options.length));
        } else {
          setActiveIndex((index) => (index + 1) % itemCount);
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        if (action && options.length > 0) {
          setActiveIndex((index) => (index >= options.length ? options.length - 1 : (index - 1 + options.length) % options.length));
        } else {
          setActiveIndex((index) => (index - 1 + itemCount) % itemCount);
        }
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(itemCount - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        choose(activeIndex);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
        break;
    }
  }

  return (
    <span
      ref={rootRef}
      className={classes}
      data-disabled={isDisabled}
      data-open={open}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeMenu();
      }}
    >
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className="select-menu-trigger chevron-trigger"
        aria-label={ariaLabel}
        aria-haspopup={action ? "menu" : "listbox"}
        aria-expanded={open}
        aria-controls={listboxId}
        data-testid={testId}
        data-value={value}
        title={selected?.title ?? title}
        disabled={isDisabled}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="select-menu-label">
          <span className="select-menu-value">{selected?.label ?? placeholder}</span>
          {/* 和原生 select 一样按最长的选项定宽，切换选项时宽度不跳；文字放在伪元素里，不进 textContent。 */}
          {[placeholder, ...options.map((option) => option.label)].map((label, index) => (
            <span key={index} className="select-menu-sizer" data-label={label} aria-hidden="true" />
          ))}
        </span>
        <Icon name={open && openChevronIcon ? openChevronIcon : chevronIcon} className="disclosure-chevron" />
      </button>
      {open && !isDisabled && (
        <div
          ref={listboxRef}
          id={listboxId}
          className="select-menu-listbox"
          popover={SUPPORTS_POPOVER ? "manual" : undefined}
          role={action ? "menu" : "listbox"}
          aria-label={ariaLabel}
          aria-activedescendant={
            activeIndex < options.length
              ? `${id}-option-${activeIndex}`
              : `${id}-action`
          }
          tabIndex={-1}
          onKeyDown={handleListboxKeyDown}
        >
          <div className="select-menu-options" role="presentation">
            {options.map((option, index) => (
              <div
                key={option.value}
                id={`${id}-option-${index}`}
                className="select-menu-option"
                role={action ? "menuitemradio" : "option"}
                data-testid={option.testId}
                title={option.title}
                aria-selected={action ? undefined : option.value === value}
                aria-checked={action ? option.value === value : undefined}
                data-active={index === activeIndex}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(index)}
              >
                {checkPosition === "left" && (
                  <span className="select-menu-check-slot" aria-hidden="true">
                    {option.value === value ? <span className="select-menu-check">✓</span> : null}
                  </span>
                )}
                <span className="select-menu-label-text">{option.label}</span>
                {checkPosition !== "left" && option.value === value && (
                  <span className="select-menu-check" aria-hidden="true">✓</span>
                )}
              </div>
            ))}
          </div>
          {action && (
            <div className="select-menu-footer" role="presentation">
              {options.length > 0 && <div role="separator" className="select-menu-divider" />}
              <div
                id={`${id}-action`}
                className="select-menu-option select-menu-action"
                role="menuitem"
                data-testid={action.testId}
                data-active={activeIndex === options.length}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(options.length)}
                onClick={() => {
                  action.onSelect();
                  closeMenu(false);
                }}
              >
                {checkPosition === "left" ? (
                  <span className="select-menu-check-slot" aria-hidden="true">
                    {action.icon ?? <Icon name="plus" className="select-menu-action-icon" />}
                  </span>
                ) : (
                  action.icon && <span className="select-menu-action-icon">{action.icon}</span>
                )}
                <span className="select-menu-label-text">{action.label}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </span>
  );
}
