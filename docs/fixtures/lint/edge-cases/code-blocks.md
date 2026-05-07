# Code Blocks

A real h1 above. The fenced block below contains what looks like a
duplicate `## Setup` heading, but the lint engine should ignore both
because they're inside a code fence.

## Setup

The real ## Setup section above. The two below should not count:

```markdown
## Setup

Some setup steps inside a code example.

## Setup
```

After the fence, prose continues normally.
