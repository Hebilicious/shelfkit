/**
 * Print the install script a deployment serves (`src/install-script.ts`), so the release workflow can run exactly that
 * script on each platform it publishes for:
 *
 *   node apps/worker/scripts/install-script.ts install.sh <version> <origin>
 *
 * Node runs it as it is, stripping the types; nothing has to be installed first.
 */
import { installScript } from "../src/install-script.ts";

const [name = "", version = "", origin = ""] = process.argv.slice(2);
const script = installScript(name, version, origin);
if (script === null || version === "" || origin === "") {
  process.stderr.write(
    "usage: node apps/worker/scripts/install-script.ts install.sh|install.ps1 <version> <origin>\n"
  );
  process.exit(2);
}
process.stdout.write(script);
