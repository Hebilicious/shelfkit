/** The sections of a shelf and the route helpers the screens share, apart from the router so screens need not import it. */
import type { RouteLocationRaw } from "vue-router";

import type { GoTarget } from "./lib/keys.ts";

/**
 * Every place `g` and a letter go, with the words the keyboard help uses. `nav` marks the sections the shelf's
 * navigation lists; the profile editor and Install are reached from a profile, so the bar does not list them.
 */
export const SECTIONS = [
  { key: "s", name: "shelf", nav: true, title: "Browse" },
  { key: "l", name: "prompts", nav: true, title: "Prompts" },
  { key: "p", name: "profiles", nav: true, title: "Profiles" },
  { key: "c", name: "compose", nav: false, title: "New profile" },
  { key: "k", name: "compile", nav: false, title: "Install a profile" },
  { key: "i", name: "import", nav: true, title: "Import" },
  { key: "a", name: "activity", nav: true, title: "Repositories" },
  { key: ",", name: "settings", nav: true, title: "Settings" },
] as const satisfies readonly {
  key: string;
  name: GoTarget;
  nav: boolean;
  title: string;
}[];

/** Which navigation entry a route belongs to: an item under Browse, the editor and Install under Profiles. */
export function sectionOf(route: string): string {
  switch (route) {
    case "item": {
      return "shelf";
    }
    case "compose":
    case "compile": {
      return "profiles";
    }
    default: {
      return route;
    }
  }
}

/** Where `g` and a letter go, within the shelf being viewed. */
export function sectionRoute(shelf: string, name: GoTarget): RouteLocationRaw {
  return { name, params: { shelf } };
}

/** The route parameter as one string. */
export function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
