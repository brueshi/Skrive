import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { variants, type VariantProps, type VariantSchema } from './variants';
import styles from './Button.module.css';

// The reference primitive (SKR-107). Demonstrates the contract every component
// follows: a typed variant API, `className` passthrough so consumers can
// override, native element props forwarded, and a forwarded ref. It consumes
// component-tier tokens (tokens.css), never raw semantic values.
//
// asChild/Slot polymorphism is the remaining piece of the contract and lands
// next — pending the Radix-Slot-vs-hand-rolled call.

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
  VariantProps<typeof buttonVariants>;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button({ variant, tone, size, className, type, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        className={button({ variant, tone, size, className })}
        {...rest}
      />
    );
  }
);
