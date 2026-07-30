import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { variants, type VariantProps, type VariantSchema } from './variants';
import styles from './IconButton.module.css';

// The boxed glyph button (SKR-210): a transparent square that centers one
// glyph — SVG or a text mark — and fills softly on hover. Replaces the
// hand-rolled per-surface copies (.header-icon-button, sidebar .icon-button,
// .diff-close, .bl-close, .fm-panel .remove-button). Toggle state is styled
// off aria-pressed, so pressing semantics and pressed ink can't drift apart.
//
// aria-label is required: an icon-only button has no accessible name without
// it. The tiny bare "×" glyphs (chips, dictionary rows) are deliberately NOT
// this primitive — they get absorbed when the chip editors unify.
//
// What is NOT a candidate, established by sweeping every raw icon button:
//
//   - Anything below 22px. There is a family of 18px INLINE affordances — the
//     word-count chevron, the sidebar's pin — that are marks inside a row or a
//     badge rather than chrome buttons in their own right, and they behave like
//     it: the pin lives at opacity 0 and is revealed by its ROW's hover, which
//     is not a state this primitive models. They are below the size scale the
//     same way a 1px hairline is below the radius scale. Pulling them in would
//     mean an `xs` size plus a reveal-on-ancestor-hover mode, which is a
//     question about what the primitive is for, not cleanup.
//   - Split-button segments (the copy-page chevron), which carry padding and a
//     shared border with the button they are welded to. They are half of a
//     control, not a square.
//
// The rule that falls out: this primitive is for a FREESTANDING square glyph
// button that is chrome. If a candidate needs a size off the scale, or gets its
// visibility from something other than itself, it is a different control.

const iconButtonVariants = {
  size: {
    sm: styles.sm,
    md: '',
    lg: styles.lg
  }
} satisfies VariantSchema;

const iconButton = variants({
  base: styles.iconButton,
  variants: iconButtonVariants,
  defaultVariants: { size: 'md' }
});

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof iconButtonVariants> & {
    'aria-label': string;
  };

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ size, className, type, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        className={iconButton({ size, className })}
        {...rest}
      />
    );
  }
);
