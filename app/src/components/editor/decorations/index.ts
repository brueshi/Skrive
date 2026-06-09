// Public entry point for the inline-preview decorations system.
//
// Call `inlinePreview()` and spread it into your CodeMirror extension
// list. The returned array bundles every per-feature decoration module
// registered in `HANDLERS` below.

import { createInlinePlugin, markerModeField } from './shared';
import type { HandlerMap } from './shared';
import { codeHandlers } from './code';
import { emphasisHandlers } from './emphasis';
import { headingHandlers } from './headings';
import {
  imageContextField,
  imageHandlers,
  imageResolverField
} from './images';
import { linkHandlers } from './links';
import {
  personalDictionaryField,
  spellcheckFrontmatterPlugin,
  spellcheckHandlers
} from './spellcheck';
import { stableEmphasisField } from './stable';

export {
  setImageContext,
  setImageResolver,
  type ImageContext,
  type ImageResolver
} from './images';
export { setPersonalDictionary } from './spellcheck';
export { setMarkerMode, markerModeField } from './shared';

const HANDLERS: HandlerMap = {
  ...emphasisHandlers,
  ...headingHandlers,
  ...linkHandlers,
  ...codeHandlers,
  ...imageHandlers,
  ...spellcheckHandlers
};

export function inlinePreview() {
  return [
    // The image handler reads these two fields; registering them as config
    // inputs makes the plugin rebuild when either is replaced via its
    // StateEffect, instead of waiting for the next doc/selection change.
    createInlinePlugin(HANDLERS, (state) => [
      state.field(imageContextField, false),
      state.field(imageResolverField, false)
    ]),
    markerModeField,
    stableEmphasisField,
    spellcheckFrontmatterPlugin,
    personalDictionaryField,
    imageContextField,
    imageResolverField
  ];
}
