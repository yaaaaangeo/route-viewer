$ErrorActionPreference = 'Stop'
$root = 'c:\Users\User\Downloads\route-viewer-main\route-viewer-main'
New-Item -ItemType Directory -Force -Path "$root\vendor\leaflet\images" | Out-Null
New-Item -ItemType Directory -Force -Path "$root\vendor\xlsx" | Out-Null

$files = @(
  @{ url = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; out = "$root\vendor\leaflet\leaflet.css" },
  @{ url = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';  out = "$root\vendor\leaflet\leaflet.js" },
  @{ url = 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png';    out = "$root\vendor\leaflet\images\marker-icon.png" },
  @{ url = 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png'; out = "$root\vendor\leaflet\images\marker-icon-2x.png" },
  @{ url = 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png';  out = "$root\vendor\leaflet\images\marker-shadow.png" },
  @{ url = 'https://unpkg.com/leaflet@1.9.4/dist/images/layers.png';         out = "$root\vendor\leaflet\images\layers.png" },
  @{ url = 'https://unpkg.com/leaflet@1.9.4/dist/images/layers-2x.png';      out = "$root\vendor\leaflet\images\layers-2x.png" },
  @{ url = 'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js'; out = "$root\vendor\xlsx\xlsx.full.min.js" }
)

foreach ($f in $files) {
  Invoke-WebRequest -Uri $f.url -OutFile $f.out -TimeoutSec 180 -UseBasicParsing
  $size = (Get-Item $f.out).Length
  Write-Output ("{0,-42} {1,9} bytes" -f (Split-Path $f.out -Leaf), $size)
}
Write-Output 'vendor OK'
