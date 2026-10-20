/** Shapes of query results that several components share. */
import type { ResultOf } from "./graphql.ts";
import type { ComposeQuery } from "./operations.ts";

type ComposeShelf = NonNullable<ResultOf<typeof ComposeQuery>["shelf"]>;

/** An item as the composer's inventory lists it. */
export type InventoryItem = ComposeShelf["items"]["nodes"][number]["item"];

/** Another profile of the shelf, as the composer offers it to `extends`. */
export type ProfileOption = ComposeShelf["profiles"][number];

/** The drag-and-drop type an item id travels under, from the inventory to the profile. */
export const ITEM_DRAG_TYPE = "application/x-shelfkit-item";
