# ui — the component library (SKR-107)

The primitive layer Skrive's feature components build on. It exists so recurring
atoms (buttons, toggles, inputs) are defined once — typed, themed, accessible —
instead of re-hand-rolled per screen against the global stylesheet.

This is **demand-driven**: add a primitive when a surviving or new surface
actually needs it, not by bulk-converting existing components. Feature
components keep working against `index.css` and adopt primitives as they're
touched.

## The four layers

1. **Tokens** — three tiers, in CSS variables.
   - *Primitive / semantic*: the existing `--skrive-*` set in `index.css`
     (colors, the radius / z-index / motion scales). Already serviceable; not
     reorganized.
   - *Component*: `tokens.css` here — the knobs a primitive exposes, expressed
     in terms of semantic tokens (`--button-bg: var(--skrive-fg)`). **Primitives
     read component tokens, never raw semantic values**, so a primitive's look
     retunes in one place.
2. **Cascade layers** — `layers.css` declares
   `@layer tokens, base, components, overrides`. Primitive CSS lives in
   `@layer components`. The global `index.css` is intentionally **unlayered**,
   so it outranks the component layer during the migration; a consumer override
   (a passed `className`, unlayered, or placed in `@layer overrides`) beats a
   primitive deterministically.
3. **Variant API** — `variants.ts`. A typed, dependency-free helper mapping
   variant props to module classes. `className` is appended last so overrides
   win.
4. **Composition** — `Slot.tsx` powers `asChild`, so a primitive's styling and
   behaviour can be projected onto a different element (a link, a Radix trigger)
   without a wrapper.

## The contract every primitive follows

- A typed **variant API** via `variants(...)`; expose `variant` / `size` / `tone`
  as the public surface.
- **`className` passthrough** — never swallow it; it's the override seam.
- **Forward the ref** and spread native element props (`...rest`).
- **`asChild`** via `Slot` where the primitive wraps a single element.
- Consume **component tokens**, never raw `--skrive-*` values, in the
  `.module.css` (wrapped in `@layer components`).
- Bake in **accessibility** once (roles, `aria-*`, focus) rather than
  re-deriving it per consumer.

## Adding a primitive

Copy `Button` as the template:

- `Thing.tsx` — `forwardRef`, a `variants(...)` call, `className` passthrough,
  optional `asChild`.
- `Thing.module.css` — `@layer components { ... }`, consuming component tokens.
- `tokens.css` — add the `--thing-*` component tokens, defined against semantic
  tokens.

```tsx
<Button>Cancel</Button>
<Button variant="primary">Save</Button>
<Button variant="primary" tone="danger">Delete</Button>
<Button asChild><a href="/docs">Open docs</a></Button>
```
