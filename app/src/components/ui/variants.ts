// The typed variant helper — the public surface every primitive's class set is
// built from. It maps variant props to CSS-Module class names and appends a
// passthrough `className` last, so a consumer override always sorts after the
// variant classes.
//
// Hand-rolled rather than pulling in CVA: the surface is small and stable, and
// keeping it dependency-free leaves the component API engine-neutral for a
// possible future package (SKR-107).

/** A variant axis maps each option name to the class it applies. Values are
 *  `string | undefined` because CSS-Module lookups are typed that way under
 *  `noUncheckedIndexedAccess`; falsy entries are skipped. */
export type VariantSchema = Record<string, Record<string, string | undefined>>;

/** The prop shape a schema implies: one optional key per axis, valued by that
 *  axis's option names. */
export type VariantProps<S extends VariantSchema> = {
  [K in keyof S]?: keyof S[K];
};

type Config<S extends VariantSchema> = {
  base?: string;
  variants: S;
  defaultVariants?: { [K in keyof S]?: keyof S[K] };
};

/** Join truthy class fragments with single spaces. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** Build a class-name function from a variant schema. The returned function
 *  takes the chosen variants plus an optional `className`, appended last so a
 *  consumer override beats the variant classes. */
export function variants<S extends VariantSchema>(config: Config<S>) {
  return (props: VariantProps<S> & { className?: string } = {}): string => {
    const out: string[] = [];
    if (config.base) out.push(config.base);
    for (const axis in config.variants) {
      const map = config.variants[axis];
      if (!map) continue;
      const choice = (props[axis] ?? config.defaultVariants?.[axis]) as
        | string
        | undefined;
      if (choice == null) continue;
      const cls = map[choice];
      if (cls) out.push(cls);
    }
    if (props.className) out.push(props.className);
    return out.join(' ');
  };
}
