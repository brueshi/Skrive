import { forwardRef, type ButtonHTMLAttributes, type Ref } from 'react';
import { Slot } from './Slot';
import { variants, type VariantProps, type VariantSchema } from './variants';
import styles from './Button.module.css';

// The reference primitive (SKR-107). Demonstrates the contract every component
// follows: a typed variant API, `className` passthrough so consumers can
// override, native element props forwarded, a forwarded ref, and `asChild`
// polymorphism via Slot (render the styling onto a different element — e.g. a
// link — instead of a <button>). It consumes component-tier tokens
// (tokens.css), never raw semantic values.

const buttonVariants = {
  variant: {
    primary: styles.primary,
    secondary: styles.secondary
  },
  tone: {
    default: '',
    danger: styles.danger
  },
  size: {
    sm: styles.sm,
    md: ''
  }
} satisfies VariantSchema;

const button = variants({
  base: styles.button,
  variants: buttonVariants,
  defaultVariants: { variant: 'secondary', tone: 'default', size: 'md' }
});

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    /** Render the styling onto the single child element instead of a <button>
     *  (e.g. wrap an <a> to get a link that looks like a button). */
    asChild?: boolean;
  };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { asChild, variant, tone, size, className, type, ...rest },
    ref
  ) {
    const cls = button({ variant, tone, size, className });
    if (asChild) {
      // The child supplies its own element + `type`, so we forward only the
      // computed class, the ref, and the rest of the props.
      return <Slot ref={ref as Ref<HTMLElement>} className={cls} {...rest} />;
    }
    return (
      <button ref={ref} type={type ?? 'button'} className={cls} {...rest} />
    );
  }
);
