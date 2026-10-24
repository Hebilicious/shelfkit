/** The shelf the current screen works in, from the route. */
import { computed } from "vue";
import type { ComputedRef } from "vue";
import { useRoute } from "vue-router";

import { param } from "../navigation.ts";

export function useShelfId(): ComputedRef<string> {
  const route = useRoute();
  return computed(() => param(route.params.shelf));
}
