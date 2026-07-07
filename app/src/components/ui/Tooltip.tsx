import * as RadixTooltip from '@radix-ui/react-tooltip';
import { platformShortcut } from '../../lib/commands/shortcut-display';
import styles from './Tooltip.module.css';

// The hover tooltip for icon-only controls (SKR-228): a calm anchored floater
// naming the control, with its keyboard shortcut when one is bound. Radix
// supplies the behavior the pattern needs — delay-on-open, instant-move
// between adjacent controls (the provider's skip window), collision-aware
// flipping, Escape dismissal — so none of that timer logic lives here.
//
// Anchored to the trigger, never pointer-following. Labels only: a tooltip
// never explains why a control is disabled (that's a different pattern), and
// disabled buttons don't fire pointer events so the question doesn't arise.
//
// The trigger child is cloned via asChild, so it must take a ref and spread
// props onto a DOM element — a raw <button>/<a> or a kit primitive like
// IconButton qualifies; a component that swallows unknown props does not.

/** App-level context for tooltip timing. Mount once around the tree so the
 *  open delay is skipped when the pointer moves between adjacent controls. */
export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={550} skipDelayDuration={350}>
      {children}
    </RadixTooltip.Provider>
  );
}

export type TooltipProps = {
  label: string;
  /** macOS-symbol shortcut hint ("⌘E"), rendered through platformShortcut so
   *  Windows reads Ctrl+E. Omit where none is bound. */
  shortcut?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** Force-close override. Pass `false` to suppress the tooltip (e.g. while
   *  the menu the trigger opens is showing — a tooltip stacked on a menu is
   *  noise); leave undefined for normal hover/focus behavior. */
  open?: false;
  children: React.ReactElement;
};

export function Tooltip({ label, shortcut, side = 'top', open, children }: TooltipProps) {
  return (
    <RadixTooltip.Root open={open}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          className={styles.content}
          side={side}
          sideOffset={6}
          collisionPadding={8}
        >
          {label}
          {shortcut && <kbd className={styles.kbd}>{platformShortcut(shortcut)}</kbd>}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
