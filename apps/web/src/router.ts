/**
 * The screens from `docs/PRD.md` section 9. Everything but sign-in and share pages lives under one shelf,
 * `/shelves/:shelf/...`, since every read and write happens in the context of one shelf.
 *
 * Every screen is in the main bundle rather than a chunk of its own: a section opens in the frame it is clicked,
 * instead of after a download. Only the WebAssembly engine, which the composer and Install run, loads separately.
 */
import { createRouter, createWebHistory } from "vue-router";

import ActivityScreen from "./screens/activity.vue";
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
import ShelfLayoutScreen from "./screens/shelf-layout.vue";
import ShelfScreen from "./screens/shelf.vue";
import SignInScreen from "./screens/sign-in.vue";

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
      component: ShareScreen,
      name: "share",
      path: "/share/:token",
    },
    {
      children: [
        {
          component: ShelfScreen,
          name: "shelf",
          path: "",
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
