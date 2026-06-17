// Single source of truth for the user-feedback form. Surfaced two ways:
// the one-time launch nudge (App.tsx) and a permanent entry in
// Settings -> About. Both call openFeedbackForm() so the URL and its
// error handling live in exactly one place.

import { logProjectError } from '../stores/project';

/** Tally feedback form. */
export const FEEDBACK_FORM_URL = 'https://tally.so/r/MeGkKl';

/** Open the feedback form in the OS default browser. Fire-and-forget:
 *  a failure to hand off to the shell is logged, not surfaced. */
export function openFeedbackForm(): void {
  void window.skrive.links
    .openExternal(FEEDBACK_FORM_URL)
    .catch((err) => logProjectError('feedback:open-form', err));
}
