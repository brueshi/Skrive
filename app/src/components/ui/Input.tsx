import {
  forwardRef,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react';
import { variants, type VariantProps, type VariantSchema } from './variants';
import styles from './Input.module.css';

// The text field primitive (SKR-212). One focus language for the app:
// boxed (default) = rule border with the accent focus glow — the settings
// treatment, canonical per the stage-3 decision; quiet = chrome-free until
// engaged (hover reveals a hairline, focus a fg border), for inline-editing
// rows like the frontmatter panel. The truly naked inputs (rename, search,
// cmdk, link editor) stay surface-owned on purpose — their focus ring is
// carried by the parent surface, not the field.
//
// Site typography (mono key fields, the report modal's larger scale) rides
// the className passthrough; the primitive owns border, background, and
// focus behavior only.

const inputVariants = {
  variant: {
    boxed: '',
    quiet: styles.quiet
  }
} satisfies VariantSchema;

const input = variants({
  base: styles.input,
  variants: inputVariants,
  defaultVariants: { variant: 'boxed' }
});

export type InputProps = InputHTMLAttributes<HTMLInputElement> &
  VariantProps<typeof inputVariants>;

export const Input = forwardRef<HTMLInputElement, InputProps>(
  function Input({ variant, className, ...rest }, ref) {
    return <input ref={ref} className={input({ variant, className })} {...rest} />;
  }
);

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> &
  VariantProps<typeof inputVariants>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ variant, className, ...rest }, ref) {
    return (
      <textarea ref={ref} className={input({ variant, className })} {...rest} />
    );
  }
);
