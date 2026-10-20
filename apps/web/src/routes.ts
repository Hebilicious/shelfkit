/**
 * The screens from docs/PRD.md section 9. Kept as data so the eventual router
 * and the current placeholder render from one list.
 */
export interface ShelfKitRoute {
  path: string;
  title: string;
  note: string;
}

export const SHELFKIT_ROUTES: ShelfKitRoute[] = [
  {
    note: "Inventory. Search, filter, bulk-select into a profile.",
    path: "/",
    title: "Shelf",
  },
  {
    note: "Copy with variables, copy as skill, favourites, search.",
    path: "/prompts",
    title: "Prompts",
  },
  {
    note: "Content, revisions, provenance, reverse dependencies.",
    path: "/item",
    title: "Item",
  },
  {
    note: "Build a profile and watch apm.yml update live.",
    path: "/compose",
    title: "Compose",
  },
  {
    note: "Pick a profile and repository, copy the install command.",
    path: "/compile",
    title: "Compile",
  },
  {
    note: "Pull items from a repo, registry, catalog, or shelf.",
    path: "/import",
    title: "Import",
  },
  {
    note: "Which repositories compiled which revision.",
    path: "/activity",
    title: "Activity",
  },
  {
    note: "Keys, sources, secret names, registry visibility.",
    path: "/settings",
    title: "Settings",
  },
];
