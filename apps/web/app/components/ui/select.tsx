import * as React from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";

import { cn } from "~/lib/utils";

/**
 * Themed `<select>` replacement, built on `@base-ui/react/select` so it
 * inherits the same primitive layer as our DropdownMenu (no Radix coexistence
 * weirdness). The trigger looks identical to <Input>; the popup is themed
 * with our token palette so it stops looking like the OS native dropdown.
 *
 * Usage:
 *   <Select value={x} onValueChange={setX}>
 *     <SelectTrigger>
 *       <SelectValue placeholder="Pick one" />
 *     </SelectTrigger>
 *     <SelectContent>
 *       <SelectItem value="a">A</SelectItem>
 *       <SelectItem value="b">B</SelectItem>
 *     </SelectContent>
 *   </Select>
 */

function Select<Value, Multiple extends boolean | undefined = false>(
  props: React.ComponentProps<typeof SelectPrimitive.Root<Value, Multiple>>,
) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectValue({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn("truncate", className)}
      {...props}
    />
  );
}

type SelectTriggerProps = React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: "default" | "sm" | "lg";
};

function SelectTrigger({
  className,
  children,
  size = "default",
  ...props
}: SelectTriggerProps) {
  const heightCls =
    size === "sm" ? "h-8 text-xs" : size === "lg" ? "h-12 text-base" : "h-10 text-sm";
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        // mirrors the Input chrome so a Select sits visually flush next to one
        "flex w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 shadow-sm",
        "ring-offset-background placeholder:text-muted-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[popup-open]:ring-2 data-[popup-open]:ring-ring",
        "touch-manipulation [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4",
        heightCls,
        className,
      )}
      {...props}
    >
      <span className="flex flex-1 items-center gap-2 truncate text-left">
        {children}
      </span>
      <SelectPrimitive.Icon className="opacity-60">
        <ChevronDownIcon />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Popup> &
  Pick<
    React.ComponentProps<typeof SelectPrimitive.Positioner>,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <SelectPrimitive.ScrollUpArrow className="flex h-6 cursor-default items-center justify-center rounded-t-md bg-popover text-popover-foreground">
          <ChevronUpIcon className="size-4" />
        </SelectPrimitive.ScrollUpArrow>
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            "z-50 max-h-[min(var(--available-height,18rem),18rem)] min-w-(--anchor-width) origin-(--transform-origin) overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-none",
            "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
            "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            "data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2",
            className,
          )}
          {...props}
        >
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
        </SelectPrimitive.Popup>
        <SelectPrimitive.ScrollDownArrow className="flex h-6 cursor-default items-center justify-center rounded-b-md bg-popover text-popover-foreground">
          <ChevronDownIcon className="size-4" />
        </SelectPrimitive.ScrollDownArrow>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex w-full cursor-default touch-manipulation select-none items-center rounded-md py-2 pr-8 pl-2 text-sm outline-none",
        "data-highlighted:bg-accent data-highlighted:text-accent-foreground",
        "data-[selected]:font-medium",
        "data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="truncate">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="pointer-events-none absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
        <CheckIcon className="size-4" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function SelectGroup({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectGroupLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.GroupLabel>) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-group-label"
      className={cn("px-2 py-1 text-xs font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectGroup,
  SelectGroupLabel,
};
