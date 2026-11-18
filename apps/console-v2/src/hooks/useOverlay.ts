// useOverlay.ts — imperative escape hatches for overlay components.
//
// The Drawer / Modal / Palette components are deliberately controlled (open
// + onClose). For the legacy demo callers that want `openDrawer({...})`-style
// imperative control, these hooks expose:
//
//   const drawer = useDrawer();
//   drawer.open({ title: 'X', body: <Foo /> });
//   drawer.close();
//   // and somewhere in the render tree:
//   {drawer.node}
//
// The hook owns the controlled state internally. Each `open()` replaces the
// current props (matching the demo's "one drawer at a time" semantics).
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Drawer, type DrawerProps, type DrawerSize } from '../components/Drawer';
import { Modal, type ModalProps } from '../components/Modal';
import { Palette, type PaletteItem, type PaletteProps } from '../components/Palette';

// React.createElement is used directly so this file does not need a JSX runtime
// — keeping it a `.ts` file (no JSX) makes it cheap to import from non-React
// utilities while still rendering valid React nodes.
import { createElement } from 'react';

// ---------- Drawer ----------
export interface OpenDrawerOptions {
  title?: ReactNode;
  body: ReactNode;
  footer?: ReactNode;
  size?: DrawerSize;
  deepLink?: string;
  onClose?: () => void;
}

export interface UseDrawerHandle {
  open: (opts: OpenDrawerOptions) => void;
  close: () => void;
  /** Mount this in your tree to render the controlled Drawer. */
  node: ReactNode;
  isOpen: boolean;
}

export function useDrawer(): UseDrawerHandle {
  const [opts, setOpts] = useState<OpenDrawerOptions | null>(null);
  const isOpen = !!opts;

  const close = useCallback(() => {
    setOpts((current) => {
      current?.onClose?.();
      return null;
    });
  }, []);

  const open = useCallback((next: OpenDrawerOptions) => {
    setOpts(next);
  }, []);

  const node = useMemo<ReactNode>(() => {
    const drawerProps: DrawerProps = {
      open: isOpen,
      title: opts?.title,
      footer: opts?.footer,
      size: opts?.size,
      deepLink: opts?.deepLink,
      onClose: close,
      children: opts?.body ?? null,
    };
    return createElement(Drawer, drawerProps);
  }, [isOpen, opts, close]);

  return { open, close, node, isOpen };
}

// ---------- Modal ----------
export interface OpenModalOptions {
  title?: ReactNode;
  body: ReactNode;
  footer?: ReactNode;
  actions?: ReactNode;
  onClose?: () => void;
}

export interface UseModalHandle {
  open: (opts: OpenModalOptions) => void;
  close: () => void;
  node: ReactNode;
  isOpen: boolean;
}

export function useModal(): UseModalHandle {
  const [opts, setOpts] = useState<OpenModalOptions | null>(null);
  const isOpen = !!opts;

  const close = useCallback(() => {
    setOpts((current) => {
      current?.onClose?.();
      return null;
    });
  }, []);

  const open = useCallback((next: OpenModalOptions) => {
    setOpts(next);
  }, []);

  const node = useMemo<ReactNode>(() => {
    const modalProps: ModalProps = {
      open: isOpen,
      title: opts?.title,
      footer: opts?.footer ?? opts?.actions,
      onClose: close,
      children: opts?.body ?? null,
    };
    return createElement(Modal, modalProps);
  }, [isOpen, opts, close]);

  return { open, close, node, isOpen };
}

// ---------- Palette ----------
export interface OpenPaletteOptions<T extends PaletteItem = PaletteItem> {
  items: T[];
  placeholder?: string;
  onPick?: (item: T) => void;
  onClose?: () => void;
}

export interface UsePaletteHandle<T extends PaletteItem = PaletteItem> {
  open: (opts: OpenPaletteOptions<T>) => void;
  close: () => void;
  node: ReactNode;
  isOpen: boolean;
}

export function usePalette<T extends PaletteItem = PaletteItem>(): UsePaletteHandle<T> {
  const [opts, setOpts] = useState<OpenPaletteOptions<T> | null>(null);
  const isOpen = !!opts;

  const close = useCallback(() => {
    setOpts((current) => {
      current?.onClose?.();
      return null;
    });
  }, []);

  const open = useCallback((next: OpenPaletteOptions<T>) => {
    setOpts(next);
  }, []);

  const node = useMemo<ReactNode>(() => {
    const paletteProps: PaletteProps<T> = {
      open: isOpen,
      placeholder: opts?.placeholder,
      items: opts?.items ?? [],
      onPick: opts?.onPick,
      onClose: close,
    };
    return createElement(Palette<T>, paletteProps as PaletteProps<T>);
  }, [isOpen, opts, close]);

  return { open, close, node, isOpen };
}
