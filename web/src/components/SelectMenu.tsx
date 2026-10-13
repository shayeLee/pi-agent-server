import { zhCN } from "../i18n/zh-CN.js";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon.js";
import type { KeyboardEvent } from "react";

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
  disabled?: boolean;
  testId?: string;
  className?: string;
  placeholder?: string;
  checkPosition?: "left" | "right";
  chevronIcon?: IconName;
  openChevronIcon?: IconName;
};

/** 通用受控自绘选择器。 */
export function SelectMenu({
  options,
  action,
  value,
  onChange,
  ariaLabel,
  disabled,
  testId,
  className,
  placeholder = zhCN.select.placeholder,
  checkPosition = "right",
  chevronIcon = "down",
  openChevronIcon,
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
  const itemCount = options.length + (action ? 1 : 0);
  const isDisabled = disabled || itemCount === 0;
  const classes = ["select-menu", className].filter(Boolean).join(" ");

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
        type="button"
        className="select-menu-trigger chevron-trigger"
        aria-label={ariaLabel}
        aria-haspopup={action ? "menu" : "listbox"}
        aria-expanded={open}
        aria-controls={listboxId}
        data-testid={testId}
        data-value={value}
        title={selected?.title}
        disabled={isDisabled}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="select-menu-label">{selected?.label ?? placeholder}</span>
        <Icon name={open && openChevronIcon ? openChevronIcon : chevronIcon} className="disclosure-chevron" />
      </button>
      {open && !isDisabled && (
        <div
          ref={listboxRef}
          id={listboxId}
          className="select-menu-listbox"
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
                    {option.value === value ? <Icon name="check" className="select-menu-check" /> : null}
                  </span>
                )}
                <span className="select-menu-label-text">{option.label}</span>
                {checkPosition !== "left" && option.value === value && (
                  <Icon name="check" className="select-menu-check" />
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
