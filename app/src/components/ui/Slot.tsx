import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type Ref
} from 'react';

// Minimal `asChild` Slot (SKR-107). Renders its single child element with the
// slot's props merged onto it instead of wrapping it — so
// `<Button asChild><a/></Button>` yields a styled <a>, not a <button> around an
// <a>. It merges className, style, and event handlers, and composes refs.
//
// React 19 exposes a child element's ref as a regular prop (`child.props.ref`);
// the legacy `child.ref` is read as a fallback. Deliberately small — if a case
// ever needs Radix Slot's fuller edge-case handling, it's a drop-in swap.

type UnknownProps = Record<string, unknown>;
type Handler = (...args: unknown[]) => void;

function composeRefs<T>(
  ...refs: Array<Ref<T> | undefined>
): (node: T | null) => void {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as { current: T | null }).current = node;
    }
  };
}

function mergeProps(slot: UnknownProps, child: UnknownProps): UnknownProps {
  const merged: UnknownProps = { ...slot };
  for (const key of Object.keys(child)) {
    const slotValue = slot[key];
    const childValue = child[key];
    if (
      /^on[A-Z]/.test(key) &&
      typeof slotValue === 'function' &&
      typeof childValue === 'function'
    ) {
      // Compose event handlers: child's runs first, then the slot's.
      merged[key] = (...args: unknown[]) => {
        (childValue as Handler)(...args);
        (slotValue as Handler)(...args);
      };
    } else if (key === 'style') {
      merged[key] = { ...(slotValue as object), ...(childValue as object) };
    } else if (key === 'className') {
      merged[key] = [slotValue, childValue].filter(Boolean).join(' ');
    } else {
      merged[key] = childValue; // child wins
    }
  }
  return merged;
}

export type SlotProps = {
  children?: ReactNode;
  ref?: Ref<HTMLElement>;
} & UnknownProps;

export function Slot({ children, ref, ...slotProps }: SlotProps) {
  if (!isValidElement(children)) return null;
  const child = children as ReactElement<UnknownProps>;
  const childProps = child.props;
  const childRef = (childProps.ref ??
    (child as { ref?: unknown }).ref) as Ref<HTMLElement> | undefined;
  const merged = mergeProps(slotProps, childProps);
  merged.ref = composeRefs(ref, childRef);
  return cloneElement(child, merged as Partial<UnknownProps>);
}
