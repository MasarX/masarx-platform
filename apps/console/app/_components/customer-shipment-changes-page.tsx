import { Suspense } from "react";
import {
  CustomerShipmentChangesPage as UiCustomerShipmentChangesPage,
  LoadingState,
} from "@masarx/ui";

type CustomerShipmentChangesPageProps = Parameters<
  typeof UiCustomerShipmentChangesPage
>[0];

const CustomerShipmentChangesPageInner =
  UiCustomerShipmentChangesPage as unknown as (
    props: CustomerShipmentChangesPageProps,
  ) => JSX.Element;

export function CustomerShipmentChangesPage(
  props: CustomerShipmentChangesPageProps,
) {
  return (
    <Suspense
      fallback={
        <LoadingState
          variant="page"
          testId="console-customer-shipment-changes-loading"
        />
      }
    >
      <CustomerShipmentChangesPageInner {...props} />
    </Suspense>
  );
}
