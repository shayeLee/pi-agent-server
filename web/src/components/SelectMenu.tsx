import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./Icon.js";
import type { KeyboardEvent } from "react";
import { cn } from "../lib/utils.js";

export type SelectMenuOption = { value: string; label: string; title?: string };

export type SelectMenuProps = {
  options: SelectMenuOption[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  testId?: string;
  className?: string;
  placeholder?: string;
  /** Composer sits on the bottom edge, so its menu opens upward. */
  placement?: "above" | "below";
};

/** 通用受控自绘选择器。 */
export function SelectMenu({
  options,
  value,
  onChange,
  ariaLabel,
  disabled,
  testId,
  className,
  placeholder = "请选择",
  placement = "below",
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
  const isDisabled = disabled || options.length === 0;
  const classes = cn("select-menu relative inline-block min-w-0", className);

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
    const option = listboxRef.current?.children.item(activeIndex) as HTMLElement | null;
    option?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex, isDisabled]);

  function openMenu(index = selectedIndex >= 0 ? selectedIndex : 0): void {
    if (isDisabled) return;
    setActiveIndex(Math.max(0, Math.min(index, options.length - 1)));
    setOpen(true);
  }

  function closeMenu(restoreFocus = false): void {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function choose(index: number): void {
    if (isDisabled) return;
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    closeMenu(true);
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (isDisabled || open) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openMenu(event.key === "ArrowUp" && selectedIndex < 0 ? options.length - 1 : selectedIndex);
    } else if (event.key === "Home") {
      event.preventDefault();
      openMenu(0);
    } else if (event.key === "End") {
      event.preventDefault();
      openMenu(options.length - 1);
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
        setActiveIndex((index) => (index + 1) % options.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + options.length) % options.length);
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(options.length - 1);
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
        className="select-menu-trigger chevron-trigger inline-flex w-full min-h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-left text-[13px] outline-none"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        data-testid={testId}
        data-value={value}
        title={selected?.title}
        disabled={isDisabled}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="select-menu-label min-w-0 flex-1 truncate">{selected?.label ?? placeholder}</span>
        <Icon name="down" size={12} className="disclosure-chevron" />
      </button>
      {open && !isDisabled && (
        <div
          ref={listboxRef}
          id={listboxId}
          className={cn(
            "select-menu-listbox absolute z-50 max-h-[min(280px,calc(100dvh-48px))] min-w-full overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md",
            placement === "above" ? "bottom-[calc(100%+4px)]" : "top-[calc(100%+4px)] left-0",
          )}
          role="listbox"
          aria-label={ariaLabel}
          aria-activedescendant={`${id}-option-${activeIndex}`}
          tabIndex={-1}
          onKeyDown={handleListboxKeyDown}
        >
          {options.map((option, index) => (
            <div
              key={option.value}
              id={`${id}-option-${index}`}
              className="select-menu-option flex min-h-8 cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1 text-[13px] data-[active=true]:bg-accent aria-selected:text-primary"
              role="option"
              title={option.title}
              aria-selected={option.value === value}
              data-active={index === activeIndex}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            >
              <span>{option.label}</span>
              {option.value === value && <Icon name="check" className="select-menu-check" />}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
