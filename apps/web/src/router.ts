/**
 * The screens from `docs/PRD.md` section 9. Everything but sign-in and share pages lives under one shelf,
 * `/shelves/:shelf/...`, since every read and write happens in the context of one shelf.
 */
import { createRouter, createWebHistory } from "vue-router";
import type { RouteLocationRaw } from "vue-router";

import type { GoTarget } from "./lib/keys.ts";

/** The sections of a shelf, in the order the navigation lists them, with their `g` key. */
export const SECTIONS = [
  { key: "s", name: "shelf", title: "Shelf" },
  { key: "l", name: "prompts", title: "Prompts" },
  { key: "p", name: "profiles", title: "Profiles" },
  { key: "c", name: "compose", title: "Compose" },
  { key: "k", name: "compile", title: "Compile" },
  { key: "i", name: "import", title: "Import" },
  { key: "a", name: "activity", title: "Activity" },
  { key: ",", name: "settings", title: "Settings" },
] as const satisfies readonly { key: string; name: GoTarget; title: string }[];

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      component: async () => await import("./screens/home.vue"),
      name: "home",
      path: "/",
    },
    {
      component: async () => await import("./screens/sign-in.vue"),
      name: "sign-in",
      path: "/sign-in",
    },
    {
      component: async () => await import("./screens/link.vue"),
      name: "link",
      path: "/link",
    },
    {
      component: async () => await import("./screens/share.vue"),
      name: "share",
      path: "/share/:token",
    },
    {
      children: [
        {
          component: async () => await import("./screens/shelf.vue"),
          name: "shelf",
          path: "",
        },
        {
          component: async () => await import("./screens/prompts.vue"),
          name: "prompts",
          path: "prompts/:id?",
        },
        {
          component: async () => await import("./screens/item.vue"),
          name: "item",
          path: "items/:id",
        },
        {
          component: async () => await import("./screens/profiles.vue"),
          name: "profiles",
          path: "profiles",
        },
        {
          component: async () => await import("./screens/compose.vue"),
          name: "compose",
          path: "compose/:profile?",
        },
        {
          component: async () => await import("./screens/compile.vue"),
          name: "compile",
          path: "compile/:profile?",
        },
        {
          component: async () => await import("./screens/import.vue"),
          name: "import",
          path: "import",
        },
        {
          component: async () => await import("./screens/activity.vue"),
          name: "activity",
          path: "activity",
        },
        {
          component: async () => await import("./screens/settings.vue"),
          name: "settings",
          path: "settings",
        },
      ],
      component: async () => await import("./screens/shelf-layout.vue"),
      path: "/shelves/:shelf",
    },
    {
      component: async () => await import("./screens/not-found.vue"),
      name: "not-found",
      path: "/:path(.*)*",
    },
  ],
});

/** Where `g` and a letter go, within the shelf being viewed. */
export function sectionRoute(shelf: string, name: GoTarget): RouteLocationRaw {
  return { name, params: { shelf } };
}

/** The route parameter as one string. */
export function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
