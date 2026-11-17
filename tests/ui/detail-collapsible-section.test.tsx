import { render, fireEvent } from "@testing-library/react";
import { CollapsibleSection } from "../../packages/ui/src/detail/collapsible-section";

beforeEach(() => {
  localStorage.clear();
});

test("renders children inside details element", () => {
  const { container } = render(
    <CollapsibleSection id="sec-1">
      <summary>Header</summary>
      <p>Body content</p>
    </CollapsibleSection>
  );

  const details = container.querySelector("details");
  expect(details).not.toBeNull();
  expect(details!.textContent).toContain("Body content");
});

test("defaults to open when no stored state", () => {
  const { container } = render(
    <CollapsibleSection id="sec-2">
      <summary>Header</summary>
    </CollapsibleSection>
  );

  const details = container.querySelector("details");
  expect(details).not.toBeNull();
  expect(details!.open).toBe(true);
});

test("reads initial state from localStorage", () => {
  // The component stores "collapsed" state: true means collapsed (not open).
  localStorage.setItem("detail-section:sec-3", "true");

  const { container } = render(
    <CollapsibleSection id="sec-3">
      <summary>Header</summary>
    </CollapsibleSection>
  );

  const details = container.querySelector("details");
  expect(details).not.toBeNull();
  // stored "true" means collapsed=true, so open should be false
  expect(details!.open).toBe(false);
});

test("persists toggle state to localStorage", () => {
  const { container } = render(
    <CollapsibleSection id="sec-4">
      <summary>Header</summary>
    </CollapsibleSection>
  );

  const details = container.querySelector("details")!;
  expect(details.open).toBe(true);

  // Simulate closing: set open=false then fire toggle
  details.open = false;
  fireEvent(details, new Event("toggle"));

  expect(localStorage.getItem("detail-section:sec-4")).toBe("true");
});

test("uses custom storagePrefix", () => {
  const { container } = render(
    <CollapsibleSection id="panel-1" storagePrefix="custom-prefix">
      <summary>Header</summary>
    </CollapsibleSection>
  );

  const details = container.querySelector("details")!;

  // Simulate closing
  details.open = false;
  fireEvent(details, new Event("toggle"));

  expect(localStorage.getItem("custom-prefix:panel-1")).toBe("true");
  // Ensure the default prefix key was NOT used
  expect(localStorage.getItem("detail-section:panel-1")).toBeNull();
});

test("respects defaultOpen=false", () => {
  const { container } = render(
    <CollapsibleSection id="sec-5" defaultOpen={false}>
      <summary>Header</summary>
    </CollapsibleSection>
  );

  const details = container.querySelector("details");
  expect(details).not.toBeNull();
  expect(details!.open).toBe(false);
});
