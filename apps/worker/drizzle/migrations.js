import m0000 from './20261019082749_init/migration.sql';
import m0001 from './20261019082756_search/migration.sql';
import m0002 from './20261019092810_hardening/migration.sql';
import m0003 from './20261019092830_safe_prefixes_references_contentless_search/migration.sql';
import m0004 from './20261022061219_people_and_invites/migration.sql';

  export default {
    migrations: {
      "20261019082749_init": m0000,
"20261019082756_search": m0001,
"20261019092810_hardening": m0002,
"20261019092830_safe_prefixes_references_contentless_search": m0003,
"20261022061219_people_and_invites": m0004
}
  }
  