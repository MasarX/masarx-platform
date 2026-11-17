import type { UiResourceList } from "@masarx/api";

type UiResourceSort =
  | {
      key: string;
      direction: "asc" | "desc";
    }
  | null
  | undefined;

type UiResourceLister = {
  listResource: (
    resource: string,
    filters: Record<string, unknown>,
    limit: number,
    offset: number,
    sort?: UiResourceSort
  ) => Promise<UiResourceList>;
};

export async function listAllResources(
  ui: UiResourceLister,
  resource: string,
  filters: Record<string, unknown>,
  maxPageSize: number,
  sort?: UiResourceSort
): Promise<UiResourceList> {
  const items: Record<string, unknown>[] = [];
  let keys: string[] | null = null;
  let total: number | null = null;
  let offset = 0;
  let page = 0;

  while (page < 50) {
    // eslint-disable-next-line no-await-in-loop
    const list = await ui.listResource(resource, filters, maxPageSize, offset, sort);
    const pageItems = Array.isArray(list.items) ? list.items : [];
    if (!keys && Array.isArray(list.keys)) {
      keys = list.keys.filter((value): value is string => typeof value === "string");
    }
    if (typeof list.total === "number") {
      total = list.total;
    }
    items.push(...pageItems);
    offset = items.length;
    page += 1;
    if (pageItems.length === 0) break;
    if (typeof total === "number" && offset >= total) break;
  }

  return {
    resource,
    limit: items.length,
    offset: 0,
    keys,
    total,
    items,
  };
}

