/**
 * `/install.sh` and `/install.ps1`: scripts that install the `shelfkit` CLI this deployment was built with.
 *
 * Each downloads the binary for the machine's platform from the GitHub release `v<SHELFKIT_VERSION>` (built by
 * `.github/workflows/release-cli.yml`), checks it against the release's `SHA256SUMS`, and puts it in
 * `~/.local/bin`, or `SHELFKIT_INSTALL_DIR` when it is set. Nothing else on the machine changes: no shell profile
 * is edited, and nothing runs as root. The CLI's version is the deployment's, so the two always speak the same API.
 */

/** Where the release binaries are published. */
export const RELEASES =
  "https://github.com/Hebilicious/shelfkit/releases/download";

function shellScript(version: string, origin: string): string {
  return `#!/bin/sh
# Installs the ShelfKit CLI ${version}, the version ${origin} runs.
# Usage: curl -fsSL ${origin}/install.sh | sh
set -eu

version="${version}"
dir="\${SHELFKIT_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Linux) os=unknown-linux-gnu ;;
  Darwin) os=apple-darwin ;;
  *)
    echo "shelfkit: no build for $(uname -s). On Windows, in PowerShell: irm ${origin}/install.ps1 | iex" >&2
    exit 1
    ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x86_64 ;;
  arm64 | aarch64) arch=aarch64 ;;
  *)
    echo "shelfkit: no build for $(uname -m)" >&2
    exit 1
    ;;
esac
asset="shelfkit-$arch-$os.tar.gz"
base="${RELEASES}/v$version"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  else
    wget -q "$1" -O "$2"
  fi
}

echo "Downloading shelfkit $version for $arch-$os"
fetch "$base/$asset" "$tmp/$asset"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS"

expected="$(awk -v name="$asset" '$2 == name { print $1 }' "$tmp/SHA256SUMS")"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$asset" | awk '{ print $1 }')"
else
  actual="$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')"
fi
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "shelfkit: $asset does not match the release's SHA256SUMS; nothing was installed" >&2
  exit 1
fi

tar -xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$dir"
mv "$tmp/shelfkit" "$dir/shelfkit"
chmod 755 "$dir/shelfkit"

echo "Installed $dir/shelfkit"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "$dir is not on your PATH: add it, or run $dir/shelfkit" ;;
esac
`;
}

function powershellScript(version: string, origin: string): string {
  return `# Installs the ShelfKit CLI ${version}, the version ${origin} runs.
# Usage, in PowerShell: irm ${origin}/install.ps1 | iex
$ErrorActionPreference = "Stop"

$version = "${version}"
$dir = if ($env:SHELFKIT_INSTALL_DIR) { $env:SHELFKIT_INSTALL_DIR } else { Join-Path $HOME ".local\\bin" }
$asset = "shelfkit-x86_64-pc-windows-msvc.zip"
$base = "${RELEASES}/v$version"

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Downloading shelfkit $version for x86_64-pc-windows-msvc"
  Invoke-WebRequest -UseBasicParsing "$base/$asset" -OutFile (Join-Path $tmp $asset)
  Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS" -OutFile (Join-Path $tmp "SHA256SUMS")

  $line = Get-Content (Join-Path $tmp "SHA256SUMS") | Where-Object { ($_ -split "\\s+")[1] -eq $asset }
  $expected = if ($line) { ($line -split "\\s+")[0] } else { "" }
  $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $asset)).Hash.ToLower()
  if (-not $expected -or $expected -ne $actual) {
    throw "shelfkit: $asset does not match the release's SHA256SUMS; nothing was installed"
  }

  Expand-Archive -Path (Join-Path $tmp $asset) -DestinationPath $tmp -Force
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  Move-Item -Force (Join-Path $tmp "shelfkit.exe") (Join-Path $dir "shelfkit.exe")
} finally {
  Remove-Item -Recurse -Force $tmp
}

Write-Host "Installed $(Join-Path $dir 'shelfkit.exe')"
if (-not (($env:PATH -split ";") -contains $dir)) {
  Write-Host "$dir is not on your PATH: add it, or run $(Join-Path $dir 'shelfkit.exe')"
}
`;
}

const SCRIPTS: ReadonlyMap<
  string,
  (version: string, origin: string) => string
> = new Map([
  ["/install.sh", shellScript],
  ["/install.ps1", powershellScript],
]);

/** The install script the request's path names, or `null` when it names none. */
export function installScriptRoute(
  request: Request,
  version: string
): Response | null {
  const url = new URL(request.url);
  const script = SCRIPTS.get(url.pathname);
  if (script === undefined) {
    return null;
  }
  return new Response(script(version, url.origin), {
    headers: {
      "cache-control": "public, max-age=300",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}
