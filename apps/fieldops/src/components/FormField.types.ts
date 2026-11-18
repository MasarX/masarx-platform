/** Form field types define controlled values and their labels, help and error messages without importing React Native. */

import type * as React from "react";
import type { TextInputProps } from "react-native";

/**
 * Public prop surface for the FormField primitive.
 *
 * Notes for callers:
 *  - `label` is always required: the primitive intentionally rejects
 *    "placeholder-only" inputs. If
 *    you genuinely need a placeholder-only input (e.g. a search bar inside
 *    a search overlay where the surface itself names the field), use a
 *    bare `TextInput` for that one-off and document the exception.
 *  - `value` + `onChangeText` are the canonical controlled-input wire pair.
 *    Controlled values keep the form and resolver in sync in the
 *    field ops outbox flow.
 *  - `hint` is rendered as small helper text below the field. When `error`
 *    is also present, the error visually replaces the hint (the prop is not
 *    cleared from React state, just hidden, so toggling error off restores
 *    the hint without caller bookkeeping).
 *  - `error` is `string | null`: pass `null` (not `undefined`) for the
 *    "no error" state so consumers can wire validation results that may
 *    legitimately produce a nullable value (e.g. `result.error ?? null`).
 *    Passing `undefined` is also accepted and treated as "no error".
 *  - Keyboard / autocomplete / autocapitalize / autocorrect / spellCheck
 *    are pass-through to the underlying RN `TextInput` so callers can wire
 *    canonical iOS/Android keyboard surfaces without re-deriving the prop
 *    set in this primitive.
 *  - `multiline` + `numberOfLines` follow react-native semantics; when
 *    `multiline` is true the layout grows from the WCAG floor up to
 *    `numberOfLines * lineHeight` (the floor still holds for the input row).
 *  - `testID` defaults to `form-field`. Nested nodes derive their testIDs
 *    by suffixing (`form-field-input`, `form-field-label`, `form-field-hint`,
 *    `form-field-error`, `form-field-adornment-left`, `form-field-adornment-right`).
 *  - `accessibilityLabel` defaults to the visible `label`. Override only
 *    when the visible text is non-descriptive on its own.
 */
export type FormFieldProps = {
  /** Visible label rendered above the input. Always supplied so the bare component carries semantic meaning. */
  label: string;
  /** Controlled input value. */
  value: string;
  /** Change handler. Skipped when `disabled` is true so callers do not need to defensively gate. */
  onChangeText: (text: string) => void;
  /** Placeholder text shown inside the input when `value` is empty. */
  placeholder?: string;
  /** Small helper text rendered below the input. Replaced visually when `error` is present. */
  hint?: string;
  /** Error message. When present, label + border swap to the danger tone and the error text replaces the hint. Pass `null` (or omit) for no-error state. */
  error?: string | null;
  /** Visually mute the input + skip onChangeText propagation. */
  disabled?: boolean;
  /** Mask input (e.g. for password fields). Pass-through to RN `TextInput`. */
  secureTextEntry?: boolean;
  /** Pass-through to RN `TextInput.autoComplete` for canonical iOS/Android autofill surfaces. */
  autoComplete?: TextInputProps["autoComplete"];
  /** Pass-through to RN `TextInput.keyboardType` for numeric / email / phone-pad keyboards. */
  keyboardType?: TextInputProps["keyboardType"];
  /** Pass-through to RN `TextInput.autoCapitalize` (defaults handled by RN). */
  autoCapitalize?: TextInputProps["autoCapitalize"];
  /** Pass-through to RN `TextInput.autoCorrect`. */
  autoCorrect?: boolean;
  /** Pass-through to RN `TextInput.spellCheck`. */
  spellCheck?: boolean;
  /** Pass-through to RN `TextInput.maxLength`. */
  maxLength?: number;
  /** Pass-through to RN `TextInput.multiline`. When true the input grows beyond a single line. */
  multiline?: boolean;
  /** Pass-through to RN `TextInput.numberOfLines`. Combined with `multiline` to size the input area. */
  numberOfLines?: number;
  /** Optional leading adornment, typically a shared Icon glyph. */
  leftAdornment?: React.ReactNode;
  /** Optional trailing adornment slot (typically a glyph or tap action). */
  rightAdornment?: React.ReactNode;
  /** Override the default `form-field` testID. Suffixed for nested nodes. */
  testID?: string;
  /** Override the default a11y label (defaults to the visible `label`). */
  accessibilityLabel?: string;
};
