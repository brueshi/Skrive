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
// this primitive — they get absorbed when the chip editors unify (Stage 3).

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
