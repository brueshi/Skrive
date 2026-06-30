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
import { CopyPageButton } from './CopyPageButton';
import { SaveStatus } from '../chrome/SaveStatus';
import './EditorBar.css';

// The bar's three zones, all over a centered formatting toolbar: ephemeral save
// confirmation in the left gutter, the toolbar centered to the writing measure,
// and the Copy action in the right gutter. The rendered/source switch lives in
// the command palette (Skrive is rendered-first; Source is an occasional peek),
// so it's deliberately absent here.
export function EditorBar() {
  const controller = useSyncExternalStore(
    subscribeActiveBlockMenu,
    getActiveBlockMenu
  );

  return (
    <div className="editor-bar">
      <div className="editor-bar-left">
        <SaveStatus />
      </div>
      {controller && <Toolbar controller={controller} />}
      <div className="editor-bar-right">
        <CopyPageButton />
      </div>
    </div>
  );
}
