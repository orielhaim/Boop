# Boop design system

`src/theme/tokens.ts` owns the light and dark palettes, materials, typography,
spacing, shape, and motion. Canvas is the page background. Grouped surfaces
hold related rows. Raised surfaces hold standalone content. Recessed surfaces
hold fields. Overlays, selected surfaces, and glass have separate values.

## Using styles

Use Unistyles in application screens and shared controls. Use a theme callback
for semantic colors and dimensions that update without a React render. Use
the returned styles from `useVariants()` for discrete component states. Keep live offsets and transforms in
Reanimated, and pass plain values into worklets. Safe Area Context owns safe
area insets. Keyboard Controller owns IME layout. Use `useTheme()` for values
that must be React props, including navigation themes, native controls, SVGs,
and Chat Kit themes.

Use `Ink` and the appropriate text role. Use the semantic `Icon` registry for
functional glyphs and `CategoryIcon` for settings categories. Add individual
Phosphor imports in the registry so Metro includes only the icons we use.
Choose explicit logical direction for new directional glyphs.

Use the shared grouped list for lists of related choices and actions. Use
inset separators for dense rows and spacing to separate groups. Keep sheets
and floating controls distinct from matte pages. Keep application text in the
English and Hebrew message catalogs.

## Dialogs and switches

Use `useDialog()` from `src/components/ui/dialog.tsx` for app messages and
confirmations. Pass translated titles, messages, and action labels to
`show()`. It resolves to the zero-based selected action or `undefined` when
the dialog is dismissed. Give irreversible actions the `danger` tone and
keep an explicit cancel action. Set `dismissible: false` to require a choice.

Use `onSelect` for actions that leave the dialog, including opening an OS
prompt or navigating. Use `run(signal)` to keep the dialog open while work
completes. It disables input while pending, keeps the dialog open on rejection,
and aborts its signal when the owner goes away. Recheck authorization before
committing work when an API cannot be canceled. Keep OS-owned prompts native.

The host queues requests in the current window. Screen-scoped requests are
discarded on blur or unmount. Use `DialogModal` for native windows with
dialog-producing content, and put the caller under the window's boundary.
Use `useWindowDialog()` only for handoffs that replace the source route
before they report a result. App Lock and identity retirement discard
outstanding requests in every window. The backdrop samples its own window
through Expo Blur. Reduce Transparency uses a scrim and opaque card.

Use `PreferenceToggle` in grouped settings and `Switch` from
`src/components/ui/switch.tsx` for a standalone control. They animate the
controlled value after the parent updates it. Give a standalone switch an
accessible label and pass the pending state as `disabled` when a setting
cannot accept concurrent changes. Preference rows that have a separate title
action expose the switch as its own target.

The dialog progress and switch thumb animations are adapted from Reacticx
source. They use Boop's tokens, motion, and haptics.

Use `CountBadge` for notification counts on icons or in rows. Its animation
comes from Kinetik UI. The parent control owns the full accessible count.

## Theme and materials

The stored preference is a request. The theme switcher captures the outgoing
frame before it commits the requested palette to React and Unistyles. Preserve
its capture checks and disposal paths when adding theme consumers. Keep glass
out of the blur target it samples. Android targets must be in the same window
and behind the overlay, as in the tab navigator. Draw a solid overlay in
separate native modal windows where the underlying activity is unavailable.
Use verified locally available avatar images. Fallback gradients use stable
identity keys and never acquire photos.

The reveal draws the captured frame outside two difference clips. The animated
circle reveals the new palette and the fixed capsule keeps the theme selector
live. Neither clip needs a luminance-mask layer. The dock and chat glass sample
behind their controls while focused. Inactive routes use their opaque material
and release the blur view.

## Design lab

Open **Settings → Appearance → Design lab** in a development build. The lab
shows both palettes, text roles, all registered icons, avatar sizes, controls,
RTL layout, and a scrolling Android blur target. It also exercises queued
dialogs, destructive confirmation, asynchronous failure, and switch values
changed both by touch and by an external action. Change the app's theme in
Appearance before opening the lab to see the live components in that theme.
The production entry removes the lab module.

## Migration and validation

| Area                                       | Integration                                                                                               |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Startup, onboarding, lock, and navigation  | Shared tokens, root theme commit, semantic icons, and existing transitions                                |
| Chats, group details, profiles, and people | Chat Kit theme projection, prepared avatar presentation, grouped list, and shared element bounds          |
| Settings, forms, and storage               | Semantic lists, category icons, text roles, and Unistyles control variants                                |
| Calls, audio, downloads, and media         | The same theme and icon registry, with existing playback, network, and acquisition lifecycles             |
| Overlays and glass                         | One material palette, native Liquid Glass on supported iOS, and SDK 31+ blur for eligible Android targets |

Verify changes in a development build and a release build. Compare the same
route and device when collecting frame and memory data. Exercise both layouts,
font scaling, Reduce Motion, theme switching, and app-lock capture restrictions.
See `AGENTS.md` for the current platform validation limits.

The overhaul was built with Expo SDK 58, Unistyles 3.8.2 in Metro mode,
Phosphor 3.0.6, and a single Nitro Modules 0.37.2 installation. The Android
release source map contains 86 individual Phosphor glyph modules. It omits the
Design Lab module. Expo Symbols is still a peer of the tab library.

Android release smoke tests covered onboarding on API 33 and navigation on
API 37. The latter included returning from a group profile to its conversation,
composer focus, English and Hebrew layout, light and dark settings,
and scrolling Settings at increased text size. The debug build rendered
Design Lab's live blur and opaque comparison. All 246 Bun tests passed,
including the five palette contrast checks.

### Theme reveal measurements

Each run alternated Light and Dark four times on the same 60 Hz Android 17
emulator with the same account and text size. Android `gfxinfo` supplied frame
statistics. `meminfo` supplied proportional set size immediately after the run.

| Release build                          | Runs | p95 frame time | Janky frames |                 PSS |
| -------------------------------------- | ---: | -------------: | -----------: | ------------------: |
| Baseline at `a075b3c`                  |    2 |       34–53 ms |  4.45–18.37% | 373,700–377,659 KiB |
| Migrated theme with the luminance mask |    1 |          69 ms |       45.81% |         376,474 KiB |
| Simple shape clips before dock polish  |    2 |       48–53 ms | 20.27–22.86% | 388,117–394,153 KiB |

The shape clips reduced frame time and missed deadlines relative to the
mask-based migration. Both final runs had more janky frames and higher PSS
than the baseline runs. The x86_64 APK grew from 231.66 MB to 233.95 MB,
and its Hermes bundle from 14.92 MB to 15.41 MB.

These are emulator samples. They leave physical-device GPU, startup timing,
long-list, and memory-pressure performance open. Full end-to-end calling and
media workflows, interactive predictive-back cancellation, tablet layouts,
and iOS runtime behavior also remain unverified.
