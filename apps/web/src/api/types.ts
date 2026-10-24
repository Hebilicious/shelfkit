/** Shapes of query results that several components share. */
import type { ProfileSummary } from "../data/shelf.ts";

/** Another profile of the shelf, as the profile editor offers it to `extends`. */
export type ProfileOption = Pick<ProfileSummary, "id" | "title" | "document">;

/** The drag-and-drop type an item id travels under, from the item list to the profile. */
export const ITEM_DRAG_TYPE = "application/x-shelfkit-item";
