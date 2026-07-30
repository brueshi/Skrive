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
// focus behavior only. Scale is retuned by setting --input-* on the
// consumer's class rather than by out-specificity-ing the rules above.
//
// What is NOT a candidate, established by sweeping every raw <input>:
//
//   - Checkboxes and radios. This primitive is a TEXT FIELD; a checkbox shares
//     nothing with it but a tag name. The native controls in the modals and the
//     theme tiles are correct as they are.
//   - Fields whose focus ring is carried by their PARENT. The chip row's
//     trailing input, the palette and menu search fields, rename, cmdk, the
//     link editor: each sits in a surface that already shows focus-within, so
//     giving the field its own ring would draw two indicators for one focus.
//     The rule is about where the focus indicator LIVES, not how naked the
//     field looks.
//
// The test for a candidate is therefore: does this field own its own focus?
// If its surface owns it, it is not this primitive.

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
