# Unicode

Two `## Café` headings — one written with the precomposed `é` (U+00E9),
the other with `e` + combining acute (U+0301). After NFC normalization
they should compare equal and the second should flag as a duplicate.

## Café

A first café section using precomposed é.

## Café

A second café section using decomposed é.
