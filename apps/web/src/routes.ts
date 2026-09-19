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
  { path: "/", title: "Shelf", note: "Inventory. Search, filter, bulk-select into a profile." },
  {
    path: "/prompts",
    title: "Prompts",
    note: "Copy with variables, copy as skill, favourites, search.",
  },
  { path: "/item", title: "Item", note: "Content, revisions, provenance, reverse dependencies." },
  { path: "/compose", title: "Compose", note: "Build a profile and watch apm.yml update live." },
  {
    path: "/compile",
    title: "Compile",
    note: "Pick a profile and repository, copy the install command.",
  },
  {
    path: "/import",
    title: "Import",
    note: "Pull items from a repo, registry, catalog, or shelf.",
  },
  { path: "/activity", title: "Activity", note: "Which repositories compiled which revision." },
  {
    path: "/settings",
    title: "Settings",
    note: "Keys, sources, secret names, registry visibility.",
  },
];
