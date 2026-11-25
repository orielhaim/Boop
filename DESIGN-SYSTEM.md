# Boop design system

Use semantic tokens from `src/theme/tokens.ts` for light and dark palettes, surfaces, typography, spacing, and motion. Use Unistyles callbacks for theme-dependent styles and the styles returned by `useVariants()` for discrete states. Use `useTheme()` for React and native props. Keep animated transforms and offsets in Reanimated. Safe Area Context and Keyboard Controller own insets.

Use `Ink` for text, the Phosphor `Icon` registry for actions, `CategoryIcon` for settings, and grouped lists for related rows. Import individual glyphs. Use logical directions and translated English and Hebrew copy. Use `CountBadge` for notification counts and put the full accessible count on its parent control.

## Glass and theme changes

Keep the glass layer outside its blur target. On Android, keep the target behind it in the same window. Use an opaque material when Reduce Transparency is enabled, the route is inactive, or the glass cannot sample its target. The theme switcher captures the outgoing frame before committing the new palette. Preserve capture authorization and release the snapshot after the transition.

Use verified local avatar bytes or the stable identity gradient. Rendering an avatar does not authorize fetching it.

## Dialogs and switches

Use `useDialog()` for application dialogs. `show()` resolves to an action index or `undefined` on dismissal. Give destructive actions the danger tone and an explicit cancel action. Use `onSelect` for navigation and OS handoffs. Use `run(signal)` for work that must keep the dialog open and disable input while pending. Recheck authorization before committing operations that cannot be canceled. Keep system permission and authentication prompts native.

Place dialog callers under the current window's boundary. Use `DialogModal` for native windows and `useWindowDialog()` for handoffs that replace the source route. Screen-scoped dialogs retire on blur or unmount. App Lock and account retirement clear requests across windows.

Use `PreferenceToggle` in grouped settings and the controlled `Switch` elsewhere. Label standalone switches and disable changes while an operation that cannot run concurrently is pending.

## Verify UI changes

Open **Settings → Appearance → Design lab** in a development build. Exercise both themes, RTL, font scaling, Reduce Motion, Reduce Transparency, and App Lock where relevant. Verify native transitions in a release build. See [AGENTS.md](AGENTS.md) for platform validation limits.
