import { render, screen, fireEvent } from "@testing-library/react";
import { ResourceDetailModal } from "../../packages/ui/src/resource-detail-modal";

jest.mock("../../packages/ui/src/modal", () => ({
  Modal: ({ open, onOpenChange, children }: any) =>
    open ? (
      <div data-testid="modal" onClick={() => onOpenChange(false)}>
        {children}
      </div>
    ) : null,
  ModalContent: ({ children }: any) => <div>{children}</div>,
  ModalHeader: ({ children }: any) => (
    <div data-testid="modal-header">{children}</div>
  ),
  ModalTitle: ({ children }: any) => (
    <div data-testid="modal-title">{children}</div>
  ),
  ModalDescription: ({ children }: any) => (
    <div data-testid="modal-description">{children}</div>
  ),
  ModalBody: ({ children }: any) => (
    <div data-testid="modal-body">{children}</div>
  ),
}));

test("renders children when open", () => {
  render(
    <ResourceDetailModal open onOpenChange={jest.fn()}>
      <div>Child content</div>
    </ResourceDetailModal>
  );

  expect(screen.getByText("Child content")).toBeInTheDocument();
  expect(screen.getByTestId("modal")).toBeInTheDocument();
});

test("does not render when closed", () => {
  render(
    <ResourceDetailModal open={false} onOpenChange={jest.fn()}>
      <div>Child content</div>
    </ResourceDetailModal>
  );

  expect(screen.queryByText("Child content")).toBeNull();
  expect(screen.queryByTestId("modal")).toBeNull();
});

test("shows title and description", () => {
  render(
    <ResourceDetailModal
      open
      onOpenChange={jest.fn()}
      title="My Title"
      description="My Description"
    >
      <div>Body</div>
    </ResourceDetailModal>
  );

  expect(screen.getByTestId("modal-title")).toHaveTextContent("My Title");
  expect(screen.getByTestId("modal-description")).toHaveTextContent(
    "My Description"
  );
});

test("calls onOpenChange when closing", () => {
  const onOpenChange = jest.fn();

  render(
    <ResourceDetailModal open onOpenChange={onOpenChange}>
      <div>Body</div>
    </ResourceDetailModal>
  );

  fireEvent.click(screen.getByTestId("modal"));
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("renders without description", () => {
  render(
    <ResourceDetailModal open onOpenChange={jest.fn()} title="Title Only">
      <div>Body</div>
    </ResourceDetailModal>
  );

  expect(screen.getByTestId("modal-title")).toHaveTextContent("Title Only");
  expect(screen.queryByTestId("modal-description")).toBeNull();
});
