import * as React from "react";
import { useState, useCallback, useRef } from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import {
  addDays,
  addMonths,
  subMonths,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  isSameMonth,
  isSameDay,
  isToday,
} from "date-fns";
import { cn } from "~/lib/utils";

// ── helpers ────────────────────────────────────────────────────────────────

function isoToDisplay(iso: string): string {
  if (!iso || iso.length !== 10) return "";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return "";
  return `${d}/${m}/${y}`;
}

function displayToIso(text: string): string | null {
  const parts = text.split("/");
  if (parts.length !== 3) return null;
  const [d, m, y] = parts;
  if (!d || !m || !y || y.length !== 4) return null;
  const dd = parseInt(d, 10);
  const mm = parseInt(m, 10);
  const yyyy = parseInt(y, 10);
  if (isNaN(dd) || isNaN(mm) || isNaN(yyyy)) return null;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const date = new Date(yyyy, mm - 1, dd);
  if (
    date.getFullYear() !== yyyy ||
    date.getMonth() !== mm - 1 ||
    date.getDate() !== dd
  )
    return null;
  return `${String(yyyy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/** Strip non-digits and rebuild dd/mm/yyyy with auto slashes while typing */
function autoSlash(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

function parseIsoToDate(iso: string): Date | null {
  if (!iso || iso.length !== 10) return null;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  const date = new Date(y, m - 1, d);
  if (
    date.getFullYear() !== y ||
    date.getMonth() !== m - 1 ||
    date.getDate() !== d
  )
    return null;
  return date;
}

function dateToIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function monthLabel(date: Date): string {
  return date.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

function calendarDays(month: Date): Date[] {
  const start = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
  const end = endOfWeek(endOfMonth(month), { weekStartsOn: 1 });
  const days: Date[] = [];
  let cur = start;
  while (cur <= end) {
    days.push(cur);
    cur = addDays(cur, 1);
  }
  return days;
}

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;

// ── component ──────────────────────────────────────────────────────────────

export interface DatePickerProps {
  /** ISO "yyyy-MM-dd" string, or "" for no value */
  value: string;
  onChange: (iso: string) => void;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Extra classes forwarded to the outer wrapper div */
  wrapperClassName?: string;
}

export function DatePicker({
  value,
  onChange,
  className,
  placeholder = "dd/mm/yyyy",
  disabled = false,
}: DatePickerProps) {
  const [text, setText] = useState(() => isoToDisplay(value));
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState<Date>(() => {
    const d = parseIsoToDate(value);
    return d
      ? new Date(d.getFullYear(), d.getMonth(), 1)
      : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  });

  // Sync display text when value prop changes externally
  const prevValue = useRef(value);
  if (prevValue.current !== value) {
    prevValue.current = value;
    const display = isoToDisplay(value);
    if (display !== text) setText(display);
    const d = parseIsoToDate(value);
    if (d) setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
  }

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const formatted = autoSlash(e.target.value);
      setText(formatted);
      if (formatted.length === 10) {
        const iso = displayToIso(formatted);
        if (iso) onChange(iso);
      } else if (formatted === "") {
        onChange("");
      }
    },
    [onChange]
  );

  const handleBlur = useCallback(() => {
    if (!text) {
      onChange("");
      return;
    }
    const iso = displayToIso(text);
    if (iso) {
      setText(isoToDisplay(iso));
      onChange(iso);
    } else {
      // Revert to last valid value
      setText(isoToDisplay(value));
    }
  }, [text, value, onChange]);

  const handleDayClick = useCallback(
    (day: Date) => {
      const iso = dateToIso(day);
      setText(isoToDisplay(iso));
      onChange(iso);
      setOpen(false);
    },
    [onChange]
  );

  const selectedDate = parseIsoToDate(value);
  const days = calendarDays(month);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      {/* Input wrapper — mimics the Input component's border/ring style */}
      <div
        className={cn(
          "inline-flex h-9 items-center rounded-lg border border-input bg-transparent text-sm shadow-xs transition-colors",
          "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
          disabled && "pointer-events-none cursor-not-allowed opacity-50 bg-input/50",
          className
        )}
      >
        <input
          type="text"
          value={text}
          onChange={handleTextChange}
          onBlur={handleBlur}
          placeholder={placeholder}
          disabled={disabled}
          className="h-full flex-1 min-w-0 bg-transparent pl-2.5 pr-1 outline-none placeholder:text-muted-foreground text-foreground"
        />
        <PopoverPrimitive.Trigger
          disabled={disabled}
          className="flex h-full cursor-pointer items-center px-2 text-muted-foreground hover:text-foreground transition-colors outline-none"
        >
          <CalendarIcon className="h-4 w-4" />
        </PopoverPrimitive.Trigger>
      </div>

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner side="bottom" align="start" sideOffset={6} className="z-50">
          <PopoverPrimitive.Popup
            className={cn(
              "w-72 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg outline-none",
              "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-open:duration-100",
              "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-closed:duration-75"
            )}
          >
            {/* Month navigation */}
            <div className="mb-3 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setMonth((m) => subMonths(m, 1))}
                className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-accent transition-colors"
              >
                <ChevronLeftIcon className="h-4 w-4" />
              </button>
              <span className="text-sm font-semibold">{monthLabel(month)}</span>
              <button
                type="button"
                onClick={() => setMonth((m) => addMonths(m, 1))}
                className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-accent transition-colors"
              >
                <ChevronRightIcon className="h-4 w-4" />
              </button>
            </div>

            {/* Weekday headers */}
            <div className="mb-1 grid grid-cols-7 text-center">
              {WEEKDAYS.map((wd) => (
                <div
                  key={wd}
                  className="py-1 text-xs font-medium text-muted-foreground"
                >
                  {wd}
                </div>
              ))}
            </div>

            {/* Day grid */}
            <div className="grid grid-cols-7 gap-y-0.5">
              {days.map((day, i) => {
                const inMonth = isSameMonth(day, month);
                const isSelected = selectedDate
                  ? isSameDay(day, selectedDate)
                  : false;
                const isTodayDate = isToday(day);
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => handleDayClick(day)}
                    className={cn(
                      "h-8 w-full rounded-md text-sm transition-colors",
                      !inMonth && "text-muted-foreground opacity-30",
                      inMonth && !isSelected && "hover:bg-accent",
                      isTodayDate &&
                        !isSelected &&
                        "font-semibold ring-1 ring-primary",
                      isSelected &&
                        "bg-primary text-primary-foreground font-semibold"
                    )}
                  >
                    {day.getDate()}
                  </button>
                );
              })}
            </div>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
