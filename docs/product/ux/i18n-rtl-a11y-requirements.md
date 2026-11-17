# i18n/RTL + Accessibility Requirements

## Scope
- RTL-first for Arabic; LTR for English and additional locales.
- All locale and timezone behavior is settings-driven (resolve_settings).

## Locale and formatting
- Dates, numbers, and currencies use locale and timezone from ui_me_v1 + settings.
- No hardcoded locale, timezone, or date format.
- Use ISO 8601 in data payloads; format only at the UI boundary.
- Numeral shaping follows locale; avoid manual digit substitution in code.
- RTL/LTR direction is set by locale and mirrored automatically; no per-page overrides.

## RTL requirements
- Layout uses logical properties (inline-start/end) so mirroring is automatic.
- Navigation, breadcrumbs, and progress indicators mirror direction in RTL.
- Icons that imply direction must flip in RTL (arrows, chevrons).
- Avoid concatenating translated strings; use full message templates.
- Tables and charts must mirror alignment and sort direction with locale.
- Mixed LTR/RTL content (IDs, tracking numbers) must remain readable with directional isolation.

## Typography and content
- Typography tokens must include locale-specific font stacks and fallback.
- Text expansion must be supported (up to 30% longer strings).
- Provide placeholders and labels that remain clear in RTL.
- Avoid truncation that hides critical IDs; prefer multi-line wrap with copy affordance.

## Forms and inputs
- Field labels, hints, and errors are localized.
- Error summaries include links to fields and are keyboard navigable.
- Inputs support locale-aware numerals when applicable.
- Keyboard shortcuts must be locale-safe and not conflict with IME input.

## Accessibility baseline (WCAG 2.1 AA)
- Keyboard navigation for all interactive elements, including menus and tables.
- Visible focus states for every focusable element.
- Color contrast meets AA for text and controls.
- Semantic HTML first; ARIA only when necessary.
- Dialogs and drawers trap focus and restore focus on close.
- Live regions for request state updates, errors, and toast notifications.
- Table headers and row actions must be accessible to screen readers.
- Provide skip links for main content and navigation regions.
- Ensure status badges include text labels (not color-only).

## Motion and feedback
- Respect prefers-reduced-motion.
- Animations must not be required to understand status changes.

## Testing requirements
- RTL visual checks for all primary routes (Console and Portal).
- Screen reader spot checks for request flows and label download.
- Keyboard-only path for request creation, approval, and download.
- Automated a11y checks on critical flows (login, request submit, approve, download).
