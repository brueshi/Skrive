//------------------------------------------------------------------------------
//  tokens.zig — Skrive's design tokens, transcribed to Zig constants (Stage 5).
//
//  Sources: app/src/components/ui/tokens.css (the component tier) and the token
//  blocks of app/src/index.css (the semantic tier). Light theme only, per the
//  stage's non-goals. Transcription is mechanical: where CSS derives a value
//  (color-mix, rem, light-dark), the derivation is computed and the result
//  hard-coded, with a comment naming the source property and the arithmetic.
//  Every derived value below was cross-checked against Chromium's computed
//  styles with the real CSS loaded (rounding matched in all cases).
//
//  The rem trap, discovered during transcription and worth its comment:
//  index.css sets `:root { font-size: 14px }`, so 1rem = 14px in the shipped
//  app — NOT the browser-default 16px. --button-font-size: 0.8125rem is
//  therefore 11.375px, not the 13px the number was presumably chosen to be,
//  and the shipped button really does render an 11.4px label (verified via
//  getComputedStyle). The lab transcribes what renders.
//------------------------------------------------------------------------------
const draw = @import("draw.zig");

const Color = draw.Color;

// ---- Semantic surface palette (index.css, light values of light-dark()) ----
pub const bg = Color.hex(0xffffff); // --skrive-bg
pub const fg = Color.hex(0x1a1a1d); // --skrive-fg
pub const muted = Color.hex(0x73737a); // --skrive-muted
pub const rule = Color.hex(0xd8d9dd); // --skrive-rule
pub const link = Color.hex(0x4c5ba6); // --skrive-link
pub const selection = Color.hex(0x4c5ba6).withAlpha(0.13); // --skrive-selection
pub const focus_ring = Color.hex(0x4c5ba6); // --skrive-focus-ring
pub const accent = Color.hex(0x4c5ba6); // --skrive-accent
pub const danger = Color.hex(0xa84030); // --skrive-danger
pub const danger_fill = Color.hex(0xa84030); // --skrive-danger-fill
pub const on_danger_fill = Color.hex(0xffffff); // --skrive-on-danger-fill
pub const status_ok = Color.hex(0xa9c79b); // --skrive-status-ok

// ---- Shell / card (index.css) ----
pub const shell_bg = Color.hex(0xe7e8ea); // --skrive-shell-bg
pub const card_bg = Color.hex(0xffffff); // --skrive-card-bg
pub const card_border = Color.hex(0xe2e3e6); // --skrive-card-border
// --skrive-card-shadow (light): 0 1px 2px rgba(0,0,0,0.05). Blur 2px = sigma 1.
pub const card_shadow = [1]draw.Shadow{
    .{ .offset = .{ 0, 1 }, .sigma = 1, .color = Color.hex(0x000000).withAlpha(0.05) },
};
pub const shell_pad: f32 = 8; // --skrive-shell-pad
pub const shell_gap: f32 = 16; // --skrive-shell-gap
pub const card_radius: f32 = 10; // --skrive-card-radius

// ---- Radius scale (index.css) ----
pub const radius_xs: f32 = 4; // --skrive-radius-xs
pub const radius_sm: f32 = 6; // --skrive-radius-sm
pub const radius_md: f32 = 8; // --skrive-radius-md
pub const radius_lg: f32 = 12; // --skrive-radius-lg
pub const radius_xl: f32 = 16; // --skrive-radius-xl
pub const radius_pill: f32 = 999; // --skrive-radius-pill

// ---- Elevation (index.css). CSS blur-radius = 2 sigma. ----
// --skrive-shadow-modal: 0 16px 48px rgba(0,0,0,0.22)
pub const shadow_modal = [1]draw.Shadow{
    .{ .offset = .{ 0, 16 }, .sigma = 24, .color = Color.hex(0x000000).withAlpha(0.22) },
};
// --skrive-shadow-sheet: 0 14px 34px 14%, 0 3px 10px 7%
pub const shadow_sheet = [2]draw.Shadow{
    .{ .offset = .{ 0, 14 }, .sigma = 17, .color = Color.hex(0x000000).withAlpha(0.14) },
    .{ .offset = .{ 0, 3 }, .sigma = 5, .color = Color.hex(0x000000).withAlpha(0.07) },
};
// --skrive-shadow-dropdown: 0 8px 28px rgba(0,0,0,0.16)
pub const shadow_dropdown = [1]draw.Shadow{
    .{ .offset = .{ 0, 8 }, .sigma = 14, .color = Color.hex(0x000000).withAlpha(0.16) },
};
// --skrive-shadow-float (light): 0 6px 16px 12%, 0 1px 3px 8%
pub const shadow_float = [2]draw.Shadow{
    .{ .offset = .{ 0, 6 }, .sigma = 8, .color = Color.hex(0x000000).withAlpha(0.12) },
    .{ .offset = .{ 0, 1 }, .sigma = 1.5, .color = Color.hex(0x000000).withAlpha(0.08) },
};
pub const overlay_scrim = Color.hex(0x000000).withAlpha(0.35); // --skrive-overlay-scrim

// ---- Focus (index.css :focus-visible) ----
// outline: 2px solid color-mix(in srgb, --skrive-focus-ring 50%, transparent);
// outline-offset: 2px.
pub const focus_outline_width: f32 = 2;
pub const focus_outline_offset: f32 = 2;
pub const focus_outline_color = focus_ring.withAlpha(0.5);

// ---- Motion (index.css) ----
pub const duration_quick_ms: f32 = 110; // --skrive-duration-quick
pub const duration_standard_ms: f32 = 150; // --skrive-duration-standard
pub const duration_slow_ms: f32 = 160; // --skrive-duration-slow
pub const duration_drawer_ms: f32 = 220; // --skrive-duration-drawer
// --skrive-easing: cubic-bezier(0.4, 0, 0.2, 1); --skrive-easing-out:
// cubic-bezier(0.16, 1, 0.3, 1). Recorded for fidelity; the lab's animation
// store interpolates by exponential decay (anim.zig), which is the same
// family as easing-out and retargetable mid-flight — the Stage 4 call.
pub const easing = [4]f32{ 0.4, 0, 0.2, 1 };
pub const easing_out = [4]f32{ 0.16, 1, 0.3, 1 };

// ---- Type (index.css) ----
pub const ui_font_size: f32 = 14; // :root font-size — and therefore 1rem
pub const ui_line_height: f32 = 1.5; // :root line-height
pub const editor_font_size: f32 = 17; // --skrive-editor-font-size

// ---- Button (tokens.css + Button.module.css) ----
pub const button_radius: f32 = radius_md; // --button-radius: var(--skrive-radius-md)
pub const button_font_size: f32 = 11.375; // --button-font-size: 0.8125rem x 14px root
pub const button_pad_y: f32 = 7; // --button-pad-y: 0.5rem x 14
pub const button_pad_x: f32 = 15.4; // --button-pad-x: 1.1rem x 14
pub const button_fg = fg; // --button-fg
pub const button_border = rule; // --button-border
pub const button_primary_fg = bg; // --button-primary-fg
pub const button_primary_bg = fg; // --button-primary-bg
pub const button_disabled_opacity: f32 = 0.5; // .button:disabled
pub const button_primary_hover_opacity: f32 = 0.85; // .primary:hover { opacity }
// Line box: font-size x the inherited 1.5 line-height; content height the
// browser computes for the 11.375px label. Height = line box + 2 pad + 2 border.
pub const button_line_height: f32 = 17.0625; // 11.375 x 1.5, per computed style
pub const button_height: f32 = button_line_height + 2 * button_pad_y + 2; // 33.06

// ---- Input (tokens.css; carried for completeness, no Input widget) ----
pub const input_radius: f32 = radius_md;
pub const input_font_size: f32 = 13; // --input-font-size (a px literal)
// --input-focus-glow: color-mix(in srgb, --skrive-focus-ring 20%, transparent)
pub const input_focus_glow = focus_ring.withAlpha(0.2);

// ---- Segmented / Toggle / Stepper (tokens.css + module CSS) ----
// --segmented-track: color-mix(in srgb, fg 8%, rule) =
//   0.08*(26,26,29) + 0.92*(216,217,221) = (201,202,206)
pub const segmented_track = Color.hex(0xc9cace);
// --toggle-track-off: color-mix(in srgb, fg 14%, rule) =
//   0.14*(26,26,29) + 0.86*(216,217,221) = (189,190,194)
pub const toggle_track_off = Color.hex(0xbdbec2);
pub const toggle_track_on = accent; // --toggle-track-on
// --stepper-divider: color-mix(in srgb, rule 55%, bg) =
//   0.55*(216,217,221) + 0.45*(255,255,255) = (234,234,236)
pub const stepper_divider = Color.hex(0xeaeaec);

// Toggle.module.css geometry: "a 40x23 track with 2px padding (36x19 inner)
// holds a 19px knob with 17px of travel"; press-stretch widens to 22px.
pub const toggle_w: f32 = 40;
pub const toggle_h: f32 = 23;
pub const toggle_pad: f32 = 2;
pub const toggle_knob: f32 = 19;
pub const toggle_knob_stretch: f32 = 22;
// .toggle box-shadow inset rims: fg at 6% (1px ring) + fg at 7% (1px/1.5px top
// blur — no SDF inset blur, see the widget for how this is approximated).
pub const toggle_rim = fg.withAlpha(0.06);
pub const toggle_rim_top = fg.withAlpha(0.07);
// .on box-shadow: #000 7% ring + #fff 20% top highlight.
pub const toggle_on_rim = Color.hex(0x000000).withAlpha(0.07);
pub const toggle_on_highlight = Color.hex(0xffffff).withAlpha(0.2);
// .toggle:hover:not(.on): color-mix(fg 8%, track-off); .on:hover:
// color-mix(track-on 90%, #000) — a 10% darken. Both applied via mix() in the
// widget so the hover animation can interpolate them.
pub const toggle_hover_mix: f32 = 0.08;
pub const toggle_on_hover_darken: f32 = 0.10;
// .knob: #fff, three layered shadows (0.5px ring, 1px, 5px-blur drop).
pub const knob_ring = Color.hex(0x000000).withAlpha(0.04);
pub const knob_shadow = [2]draw.Shadow{
    .{ .offset = .{ 0, 1 }, .sigma = 0.5, .color = Color.hex(0x000000).withAlpha(0.10) },
    .{ .offset = .{ 0, 2 }, .sigma = 2.5, .color = Color.hex(0x000000).withAlpha(0.12) },
};

// Segmented.module.css geometry: 30px track, 2px pad, 2px gap, md/sm radii,
// 26px options with 13px horizontal padding, 12px label at weight 500 (600
// when active).
pub const segmented_h: f32 = 30;
pub const segmented_pad: f32 = 2;
pub const segmented_gap: f32 = 2;
pub const segmented_option_pad_x: f32 = 13;
pub const segmented_font_size: f32 = 12;
pub const segmented_track_radius: f32 = radius_md;
pub const segmented_option_radius: f32 = radius_sm;
// .thumb box-shadow: 0 1px 2px color-mix(fg 9%, transparent).
pub const segmented_thumb_shadow = [1]draw.Shadow{
    .{ .offset = .{ 0, 1 }, .sigma = 1, .color = fg.withAlpha(0.09) },
};

// ---- IconButton (tokens.css + IconButton.module.css) ----
pub const icon_button_size: f32 = 26; // --icon-button-size (sm 22, lg 28)
pub const icon_button_size_sm: f32 = 22;
pub const icon_button_size_lg: f32 = 28;
pub const icon_button_radius: f32 = radius_sm; // --icon-button-radius
pub const icon_button_fg = muted; // --icon-button-fg
pub const icon_button_fg_hover = fg; // --icon-button-fg-hover
// --icon-button-bg-hover: color-mix(in srgb, fg 7%, transparent)
pub const icon_button_bg_hover = fg.withAlpha(0.07);
pub const icon_button_disabled_opacity: f32 = 0.4; // .iconButton:disabled

// ---- Settings page (index.css .settings-*) — the benchmark scene's specs ----
// Not custom properties, but the class rules the benchmark scene transcribes;
// kept here so the scene and the widgets read one file.
// --settings-cap: color-mix(muted 70%, bg) = 0.7*(115,115,122)+0.3*(255,255,255)
//   = (157,157,162)
pub const settings_cap = Color.hex(0x9d9da2);
// --settings-hair: color-mix(rule 55%, bg) = (234,234,236) — same arithmetic
// as --stepper-divider, and the same result.
pub const settings_hair = Color.hex(0xeaeaec);
pub const settings_row_pad_y: f32 = 16; // .settings-row padding
pub const settings_row_pad_x: f32 = 18;
pub const settings_row_gap: f32 = 24; // .settings-row gap
pub const settings_label_size: f32 = 13.5; // .settings-row-label (weight 500)
pub const settings_label_line_height: f32 = 18;
pub const settings_desc_size: f32 = 12.5; // .settings-row-desc
pub const settings_desc_line_height: f32 = 16;
pub const settings_cap_size: f32 = 11; // .settings-section-cap (600, 0.07em)
pub const settings_title_size: f32 = 25; // .settings-pane-title (600, -0.01em,
// and the EDITOR serif face — a typeface the lab does not carry; see the log)
pub const settings_sub_size: f32 = 13.5; // .settings-pane-sub
