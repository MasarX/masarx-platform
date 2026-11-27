// Palette.tsx — command palette / picker, now backed by `cmdk`
// (Paco Coursey's command primitive used by Linear / Vercel / Raycast)
// wrapped in Radix UI Dialog primitives so the surface gets:
//
//   • automatic substring filtering across label/key/section
//   • arrow-key navigation, Enter-to-select, Esc to close
//   • screen-reader-friendly listbox/option semantics
//   • focus trap, focus restore, click-outside, escape stack
//
// Visual contract unchanged: `.palette-root` + `.is-open` toggle for the
// orchestrator wrapper, `.palette-root__backdrop` for the overlay,
// `.palette` for the sheet, `.palette__input-row`, `.palette__input`,
// `.palette__list`, `.palette__group-label`, `.palette__item`,
// `.palette__item-label`, `.palette__item-meta`, plus `.is-active` driven
// from cmdk's selection store via `useCommandState`. The legacy wrapper
// is kept so transition rules in src/styles/components.css continue to
// apply unchanged.
//
// Items can carry their own `onPick` callback (for view menus where each
// entry is its own action) — when present it is preferred over the
// component-level `onPick`. Both fire close().
import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Command, useCommandState } from 'cmdk';
import { Icon } from './Icon';
import { useI18n } from '../lib/i18n';

export interface PaletteItem {
  label: ReactNode;
  /** Stable identifier shown in the right-hand meta column. */
  key?: string | number | null;
  /** Optional sub-meta text (e.g. tone, rank). Falls back to `key`. */
  meta?: ReactNode;
  /** Group label — rendered above the first item with this section. */
  section?: string;
  /** Per-item handler. Wins over component-level `onPick`. */
  onPick?: () => void;
  /** Free-form payload retained for the component-level `onPick` callback. */
  value?: unknown;
  /** Disable the row from being chosen. */
  disabled?: boolean;
}

export interface PaletteProps<T extends PaletteItem = PaletteItem> {
  open: boolean;
  placeholder?: string;
  items: T[];
  onPick?: (item: T) => void;
  onClose: () => void;
  className?: string;
  /** Show a leading search icon + trailing `esc` chip (default true). */
  showChrome?: boolean;
}

/**
 * Group items by section while preserving original order. Items without a
 * section are bucketed under an empty key so they still render together.
 */
function groupBySection<T extends PaletteItem>(
  items: T[],
): Array<{ section: string | undefined; items: Array<{ item: T; idx: number }> }> {
  const groups: Array<{
    section: string | undefined;
    items: Array<{ item: T; idx: number }>;
  }> = [];
  let current: {
    section: string | undefined;
    items: Array<{ item: T; idx: number }>;
  } | null = null;
  items.forEach((item, idx) => {
    const section = item.section;
    if (!current || current.section !== section) {
      current = { section, items: [] };
      groups.push(current);
    }
    current.items.push({ item, idx });
  });
  return groups;
}

export function Palette<T extends PaletteItem = PaletteItem>({
  open,
  placeholder,
  items,
  onPick,
  onClose,
  className,
  showChrome = true,
}: PaletteProps<T>) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [mounted, setMounted] = useState(false);

  // Reset filter every time the palette opens (matches legacy semantics)
  // and stagger the `.is-open` toggle for the CSS enter transition.
  useEffect(() => {
    if (open) {
      setQuery('');
      const id = requestAnimationFrame(() => setMounted(true));
      return () => cancelAnimationFrame(id);
    }
    setMounted(false);
    return undefined;
  }, [open]);

  const choose = (item: T) => {
    if (item.disabled) return;
    if (onPick) {
      onPick(item);
    } else {
      item.onPick?.();
    }
    onClose();
  };

  const paletteClasses = ['palette', className].filter(Boolean).join(' ');
  const rootClasses = ['palette-root', mounted ? 'is-open' : ''].filter(Boolean).join(' ');
  const groups = groupBySection(items);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <div className={rootClasses} role="presentation">
          <Dialog.Overlay className="palette-root__backdrop" />
          <Dialog.Content
            className={paletteClasses}
            aria-label={t('shell.palette.label')}
            onOpenAutoFocus={(e) => {
              // cmdk's input picks up focus naturally via autoFocus; let it
              // drive initial focus rather than Radix's first-focusable rule.
              e.preventDefault();
            }}
          >
            {/* Hidden accessible title + description satisfy Radix Dialog AT
                semantics without changing the visual layout. */}
            <Dialog.Title style={srOnly}>{t('shell.palette.label')}</Dialog.Title>
            <Dialog.Description style={{ display: 'none' }}>
              {t('shell.palette.description')}
            </Dialog.Description>

            <Command
              label={t('shell.palette.label')}
              shouldFilter={true}
              // Substring match across label/key/section (mirrors legacy).
              filter={(value, search) => {
                if (!search) return 1;
                const v = value.toLowerCase();
                const s = search.toLowerCase();
                return v.includes(s) ? 1 : 0;
              }}
            >
              <div className="palette__input-row">
                {showChrome ? <Icon name="search" size={14} /> : null}
                <Command.Input
                  autoFocus
                  className="palette__input"
                  placeholder={placeholder ?? t('app.search', 'Search…')}
                  value={query}
                  onValueChange={setQuery}
                />
                {showChrome ? <span className="kbd">esc</span> : null}{/* i18n-literal-ok key cap */}
              </div>
              <Command.List className="palette__list">
                <Command.Empty
                  className="palette__item is-disabled"
                  style={{ pointerEvents: 'none' }}
                >
                  {t('shell.palette.empty')}
                </Command.Empty>
                {groups.map((group, gi) => {
                  const heading = group.section ? (
                    <span className="palette__group-label" aria-hidden="true">
                      {group.section}
                    </span>
                  ) : undefined;
                  const groupKey = `${group.section || '__nogroup'}_${gi}`;
                  return (
                    <Command.Group
                      key={groupKey}
                      heading={heading}
                      value={groupKey}
                    >
                      {group.items.map(({ item, idx }) => {
                        const labelText =
                          typeof item.label === 'string' ? item.label : '';
                        const haystack = [
                          labelText,
                          String(item.key ?? ''),
                          String(item.section ?? ''),
                        ]
                          .filter(Boolean)
                          .join(' ');
                        const itemValue = `${idx}::${haystack}`;
                        return (
                          <PaletteRow
                            key={`${item.key ?? idx}-${idx}`}
                            itemValue={itemValue}
                            item={item}
                            onChoose={() => choose(item)}
                          />
                        );
                      })}
                    </Command.Group>
                  );
                })}
              </Command.List>
            </Command>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface PaletteRowProps {
  itemValue: string;
  item: PaletteItem;
  onChoose: () => void;
}

/**
 * Renders a single `<Command.Item>` and bridges cmdk's selection state
 * (which uses `data-selected="true"` on the active row) to our visual
 * contract that uses `.palette__item.is-active`.
 */
function PaletteRow({ itemValue, item, onChoose }: PaletteRowProps) {
  // cmdk's store stores the currently-selected item value (trimmed). Mirror
  // it onto the legacy `.is-active` class so existing
  // `.palette__item.is-active` CSS rules in components.css continue to
  // apply.
  const selectedValue = useCommandState((state) => state.value);
  const isActive = selectedValue === itemValue.trim();
  const className = [
    'palette__item',
    isActive ? 'is-active' : '',
    item.disabled ? 'is-disabled' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const choseRef = useRef(false);
  const chooseOnce = () => {
    if (choseRef.current) return;
    choseRef.current = true;
    onChoose();
  };
  const stopPalettePointer = (event: SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const chooseFromPointer = (event: SyntheticEvent) => {
    stopPalettePointer(event);
    chooseOnce();
  };
  return (
    <Command.Item
      value={itemValue}
      disabled={item.disabled}
      onSelect={chooseOnce}
      onPointerDown={stopPalettePointer}
      onPointerUp={chooseFromPointer}
      onMouseDown={stopPalettePointer}
      onMouseUp={chooseFromPointer}
      onClick={chooseFromPointer}
      className={className}
    >
      <span className="palette__item-label">{item.label}</span>
      <span className="palette__item-meta mono">
        {item.meta ?? (item.key != null ? String(item.key) : '')}
      </span>
    </Command.Item>
  );
}

const srOnly: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  whiteSpace: 'nowrap',
  border: 0,
};
