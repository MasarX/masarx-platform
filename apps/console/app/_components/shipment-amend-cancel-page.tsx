import { Suspense } from "react";
import {
  LoadingState,
  ShipmentAmendCancelPage as UiShipmentAmendCancelPage,
} from "@masarx/ui";

type ShipmentAmendCancelPageProps = Parameters<
  typeof UiShipmentAmendCancelPage
>[0];

const ShipmentAmendCancelPageInner =
  UiShipmentAmendCancelPage as unknown as (
    props: ShipmentAmendCancelPageProps,
  ) => React.JSX.Element;

export function ShipmentAmendCancelPage(
  props: ShipmentAmendCancelPageProps,
) {
  return (
    <Suspense
      fallback={
        <LoadingState
          variant="page"
          testId="console-shipment-amend-cancel-loading"
        />
      }
    >
      <ShipmentAmendCancelPageInner {...props} />
    </Suspense>
  );
}
