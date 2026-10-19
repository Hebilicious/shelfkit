/** The relations the relational query builder (v2) follows. */
import { defineRelations } from "drizzle-orm";

import * as schema from "./schema.ts";

export const relations = defineRelations(schema, (r) => ({
  item: {
    revisions: r.many.revision({ from: r.item.id, to: r.revision.itemId }),
    scans: r.many.scan({ from: r.item.id, to: r.scan.itemId }),
    upstream: r.one.upstream({ from: r.item.id, to: r.upstream.itemId }),
  },
  profile: {
    revisions: r.many.profileRevision({
      from: r.profile.id,
      to: r.profileRevision.profileId,
    }),
  },
}));
