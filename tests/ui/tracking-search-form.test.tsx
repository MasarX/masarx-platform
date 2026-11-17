import { fireEvent, screen } from "@testing-library/react";
import { TrackingSearchForm } from "../../packages/ui/src/tracking-search-form";
import { renderWithIntl } from "./test-utils";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));

beforeEach(() => mockPush.mockReset());

test.each([
  [undefined, "Enter a tracking number before searching."],
  ["Enter an identifier before searching shipments.", "Enter an identifier before searching shipments."],
])("announces blank search with the selected context message (case %#)", (message, expected) => {
  renderWithIntl(<TrackingSearchForm actionHref="/console/track" paramKey="identifier"
    emptySearchMessage={message} testIdPrefix="search" />);
  fireEvent.change(screen.getByTestId("search-input"), { target: { value: "   " } });
  fireEvent.submit(screen.getByTestId("search-form"));
  expect(screen.getByRole("alert")).toHaveTextContent(expected);
  expect(screen.getByTestId("search-input")).toHaveAccessibleDescription(expected);
  expect(screen.getByTestId("search-input")).toHaveAttribute("aria-invalid", "true");
  expect(mockPush).not.toHaveBeenCalled();
  fireEvent.change(screen.getByTestId("search-input"), { target: { value: " TRACK-1 " } });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.submit(screen.getByTestId("search-form"));
  expect(mockPush).toHaveBeenCalledWith("/console/track?identifier=TRACK-1");
});
