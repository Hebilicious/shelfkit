/**
 * The screens from `docs/PRD.md` section 9. Everything but sign-in, approving a CLI's login, and share pages lives under one shelf,
 * `/shelves/:shelf/...`, since every read and write happens in the context of one shelf.
 *
 * Every screen is in the main bundle rather than a chunk of its own: a section opens in the frame it is clicked,
 * instead of after a download. Only the WebAssembly engine, which the composer and Install run, loads separately.
 */
import { createRouter, createWebHistory } from "vue-router";

import { KIND_GUIDES, KIND_ORDER } from "./lib/vocabulary.ts";
import ActivityScreen from "./screens/activity.vue";
import CliLoginScreen from "./screens/cli-login.vue";
import CompileScreen from "./screens/compile.vue";
import ComposeScreen from "./screens/compose.vue";
import HomeScreen from "./screens/home.vue";
import ImportScreen from "./screens/import.vue";
import ItemScreen from "./screens/item.vue";
import LinkScreen from "./screens/link.vue";
import NotFoundScreen from "./screens/not-found.vue";
import ProfilesScreen from "./screens/profiles.vue";
import PromptsScreen from "./screens/prompts.vue";
import SettingsScreen from "./screens/settings.vue";
import ShareScreen from "./screens/share.vue";
import ShelfContentScreen from "./screens/shelf-content.vue";
import ShelfLayoutScreen from "./screens/shelf-layout.vue";
import ShelfScreen from "./screens/shelf.vue";
import SignInScreen from "./screens/sign-in.vue";

/** The kinds' own addresses, except the prompts', which have their own screen. */
const KIND_SLUGS = KIND_ORDER.filter((kind) => kind !== "prompt").map(
  (kind) => KIND_GUIDES[kind].slug
);

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      component: HomeScreen,
      name: "home",
      path: "/",
    },
    {
      component: SignInScreen,
      name: "sign-in",
      path: "/sign-in",
    },
    {
      component: LinkScreen,
      name: "link",
      path: "/link",
    },
    {
      component: CliLoginScreen,
      name: "cli-login",
      path: "/cli/:code?",
    },
    {
      component: ShareScreen,
      name: "share",
      path: "/share/:token",
    },
    {
      children: [
        {
          // What the shelf holds, beside the sidebar of kinds: everything, one kind, the prompts, one item.
          children: [
            {
              component: ShelfScreen,
              name: "shelf",
              path: "",
            },
            {
              component: ShelfScreen,
              name: "kind",
              path: `:kind(${KIND_SLUGS.join("|")})`,
            },
            {
              component: PromptsScreen,
              name: "prompts",
              path: "prompts/:id?",
            },
            {
              component: ItemScreen,
              name: "item",
              path: "items/:id",
            },
          ],
          component: ShelfContentScreen,
          path: "",
        },
        {
          component: ProfilesScreen,
          name: "profiles",
          path: "profiles",
        },
        {
          component: ComposeScreen,
          name: "compose",
          path: "compose/:profile?",
        },
        {
          component: CompileScreen,
          name: "compile",
          path: "compile/:profile?",
        },
        {
          component: ImportScreen,
          name: "import",
          path: "import",
        },
        {
          component: ActivityScreen,
          name: "activity",
          path: "activity",
        },
        {
          component: SettingsScreen,
          name: "settings",
          path: "settings",
        },
      ],
      component: ShelfLayoutScreen,
      path: "/shelves/:shelf",
    },
    {
      component: NotFoundScreen,
      name: "not-found",
      path: "/:path(.*)*",
    },
  ],
});
