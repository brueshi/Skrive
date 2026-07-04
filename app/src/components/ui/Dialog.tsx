import * as RadixDialog from '@radix-ui/react-dialog';
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ReactNode
} from 'react';
import { cn } from './variants';
import styles from './Dialog.module.css';

// The scrimmed-overlay shell (SKR-211): one scrim + one panel frame for every
// Radix Dialog surface, replacing the four hand-copied frame/backdrop class
// pairs (.modal-dialog, .rename-modal, .search-palette, .cmdk-palette). The
// shell owns only the frame — position, surface, elevation, entrance motion.
// Content anatomy (titles, fields, actions) stays per-modal: pass the modal's
// content class via className; unlayered index.css beats @layer components,
// so per-modal width/layout overrides win deterministically.
//
// Radix supplies focus trap, ESC, scroll lock, and portal placement. Title /
// Description remain per-modal (imported from Radix directly) so each surface
// keeps its own a11y wiring.

type PanelVariant = 'sheet' | 'palette';

export type DialogShellProps = Omit<
  ComponentPropsWithoutRef<typeof RadixDialog.Content>,
  'asChild'
> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** sheet = centered soft card (dialogs); palette = top-anchored flex column
   *  (search / command surfaces). */
  variant?: PanelVariant;
  children: ReactNode;
};

export const DialogShell = forwardRef<HTMLDivElement, DialogShellProps>(
  function DialogShell(
    { open, onOpenChange, variant = 'sheet', className, children, ...rest },
    ref
  ) {
    return (
      <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
        <RadixDialog.Portal>
          <RadixDialog.Overlay className={styles.scrim} />
          <RadixDialog.Content
            ref={ref}
            className={cn(styles.panel, styles[variant], className)}
            {...rest}
          >
            {children}
          </RadixDialog.Content>
        </RadixDialog.Portal>
      </RadixDialog.Root>
    );
  }
);
