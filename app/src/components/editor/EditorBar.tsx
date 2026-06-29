// The persistent toolbar band above the editor body (SKR-123). One bar that
// stays put across rendered and source views: it hosts the formatting Toolbar
// when a block surface is live, and floats the rendered/source toggle plus the
// save-status dot over its right edge so the formatting tools stay centered to
// the writing measure exactly as before.
//
// The formatting Toolbar needs the mounted surface's MenuController. Rather than
// thread it down from BlockEditor (which owns the surface lifecycle), we read it
// reactively from the active-surface registry BlockEditor already registers on
// mount — so the toolbar appears/disappears as surfaces come and go (view
// toggle, file switch) with no extra wiring.

import { useSyncExternalStore } from 'react';
import { Toolbar } from './menus/Toolbar';
import { getActiveBlockMenu, subscribeActiveBlockMenu } from './active-surface';
import { SourceToggle } from '../chrome/SourceToggle';
import { SaveStatus } from '../chrome/SaveStatus';
import './EditorBar.css';

export function EditorBar() {
  const controller = useSyncExternalStore(
    subscribeActiveBlockMenu,
    getActiveBlockMenu
  );

  return (
    <div className="editor-bar">
      {controller && <Toolbar controller={controller} />}
      <div className="editor-bar-controls">
        <SourceToggle />
        <SaveStatus />
      </div>
    </div>
  );
}
