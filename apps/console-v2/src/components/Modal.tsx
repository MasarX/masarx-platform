// Modal.tsx — centered dialog backed by Radix UI Dialog primitives.
//
// Visual contract is unchanged: `.modal-root` + `.is-open` toggle for the
// orchestrator wrapper, `.modal-root__backdrop` for the overlay, `.modal`
// for the sheet (with `.modal__header`, `.modal__title`, `.modal__body`,
// `.modal__footer` slots). The legacy wrapper element is kept so transition
// rules in src/styles/components.css (which key off `.modal-root.is-open
// .modal` etc.) continue to apply unchanged.
//
// Behavior preserved:
// - Backdrop click + Esc both close (Radix Dialog handles both).
// - Open/close are controlled. Imperative use: `useModal()` in
//   src/hooks/useOverlay.ts.
// - Focus trap + focus-on-mount + focus-restore-on-close are now correct
//   (Radix Dialog's FocusScope manages them).
import { useEffect, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';

export interface ModalProps {
  open: boolean;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  className?: string;
}

export function Modal({ open, title, children, footer, onClose, className }: ModalProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (open) {
      const id = requestAnimationFrame(() => setMounted(true));
      return () => cancelAnimationFrame(id);
    }
    setMounted(false);
    return undefined;
  }, [open]);

  const modalClasses = ['modal', className].filter(Boolean).join(' ');
  const rootClasses = ['modal-root', mounted ? 'is-open' : ''].filter(Boolean).join(' ');

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <div className={rootClasses} role="presentation">
          <Dialog.Overlay className="modal-root__backdrop" />
          <Dialog.Content
            className={modalClasses}
            aria-label={typeof title === 'string' ? title : undefined}
          >
            {title != null ? (
              <header className="modal__header">
                <Dialog.Title className="modal__title">{title}</Dialog.Title>
              </header>
            ) : (
              // Radix requires a Title for AT semantics; provide a visually
              // hidden one when no title prop is supplied.
              <Dialog.Title style={srOnly}>Dialog</Dialog.Title>
            )}
            {/* Hidden description satisfies Radix's a11y requirement
                without changing the visual layout. */}
            <Dialog.Description style={{ display: 'none' }}>
              {typeof title === 'string' ? title : 'Dialog'}
            </Dialog.Description>
            <div className="modal__body">{children}</div>
            {footer ? <div className="modal__footer">{footer}</div> : null}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
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
