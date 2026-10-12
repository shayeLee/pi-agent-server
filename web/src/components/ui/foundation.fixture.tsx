// Browser-only fixture, never imported by the application.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../styles.css";
import "../../styles/ui.css";
import { Button } from "./button.js";
import { Badge } from "./badge.js";
import { Separator } from "./separator.js";
import { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription, DialogClose } from "./dialog.js";
import { Popover, PopoverTrigger, PopoverContent, PopoverClose } from "./popover.js";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "./tooltip.js";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuSeparator } from "./dropdown-menu.js";

function Fixture() {
  const [selected, setSelected] = useState("None");
  const [checked, setChecked] = useState(false);
  return <main data-ui="fixture" className="ui:flex ui:min-h-screen ui:flex-col ui:items-start ui:gap-4 ui:bg-surface ui:p-6 ui:font-sans ui:text-foreground">
    <h1>UI foundation — isolated fixture</h1>
    <Button onClick={() => setSelected("Button")}>Action</Button>
    <Button disabled>Disabled</Button>
    <Button asChild variant="outline"><a href="#anchor">Anchor</a></Button>
    <Badge>Ready</Badge><Badge variant="secondary">Secondary</Badge><Badge variant="outline">Outline</Badge>
    <Separator decorative={false} />
    <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline">Menu</Button></DropdownMenuTrigger>
      <DropdownMenuContent><DropdownMenuItem onSelect={() => setSelected("First")}>First</DropdownMenuItem>
        <DropdownMenuItem disabled>Unavailable</DropdownMenuItem><DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={checked} onCheckedChange={setChecked}>Checked</DropdownMenuCheckboxItem>
      </DropdownMenuContent></DropdownMenu>
    <Dialog><DialogTrigger asChild><Button>Open dialog</Button></DialogTrigger><DialogContent>
      <DialogTitle>Foundation dialog</DialogTitle><DialogDescription>Keyboard focus stays inside until dismissed.</DialogDescription>
      <label>Value <input aria-label="Value" /></label>
      <DialogClose asChild><Button variant="outline">Close dialog</Button></DialogClose>
    </DialogContent></Dialog>
    <Popover><PopoverTrigger asChild><Button variant="ghost">Open popover</Button></PopoverTrigger><PopoverContent>
      <p>Popover content</p><PopoverClose asChild><Button>Close popover</Button></PopoverClose>
    </PopoverContent></Popover>
    <TooltipProvider delayDuration={0}><Tooltip><TooltipTrigger asChild><Button variant="outline">Help</Button></TooltipTrigger><TooltipContent>Accessible hint</TooltipContent></Tooltip></TooltipProvider>
    <output aria-label="Selection">{selected}</output><output aria-label="Checked state">{String(checked)}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
