// Generic suggestion dropdown. Stays deliberately dumb: it owns no
// filtering, no sorting, no async fetching. The parent computes the
// suggestion list and the selected index; this component renders them
// and emits pick / hover events.
//
// Anchored to an input via CSS — the parent wraps the input + dropdown
// in a `position: relative` container and the dropdown pins itself to
// `top: 100%`. The crucial bit is `onMouseDown.preventDefault()` on
// each option so mousing-down on a suggestion does NOT blur the
// anchored input — that would tear down the dropdown before the click
// event registers.

type Props = {
  suggestions: string[];
  selectedIndex: number;
  onPick: (value: string, index: number) => void;
  onHover: (index: number) => void;
};

export function SuggestionList({
  suggestions,
  selectedIndex,
  onPick,
  onHover
}: Props) {
  if (suggestions.length === 0) return null;
  return (
    <ul className="suggestion-list" role="listbox">
      {suggestions.map((suggestion, i) => (
        <li
          key={`${suggestion}::${i}`}
          className={`suggestion${i === selectedIndex ? ' selected' : ''}`}
          role="option"
          aria-selected={i === selectedIndex}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(suggestion, i);
          }}
          onMouseEnter={() => onHover(i)}
        >
          {suggestion}
        </li>
      ))}
    </ul>
  );
}
